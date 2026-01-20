import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  generateRateLimitKey,
  parseTimeWindow,
} from '../../../src/middleware/rate-limit.js';

describe('rate-limit', () => {
  describe('generateRateLimitKey', () => {
    it('should use API key when available', () => {
      const request = {
        headers: {
          'x-api-key': 'test-api-key-12345678',
        },
        auth: undefined,
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request);
      expect(key).toBe('apikey:test-api');
    });

    it('should use user ID when API key is not available', () => {
      const request = {
        headers: {},
        auth: {
          userId: 'user:12345',
          method: 'jwt',
          scopes: [],
        },
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request);
      expect(key).toBe('user:user:12345');
    });

    it('should fallback to IP when no auth', () => {
      const request = {
        headers: {},
        auth: undefined,
        ip: '192.168.1.100',
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request);
      expect(key).toBe('ip:192.168.1.100');
    });

    it('should use x-forwarded-for when IP is not available', () => {
      const request = {
        headers: {
          'x-forwarded-for': '10.0.0.1',
        },
        auth: undefined,
        ip: undefined,
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request);
      expect(key).toBe('ip:10.0.0.1');
    });

    it('should handle array x-forwarded-for', () => {
      const request = {
        headers: {
          'x-forwarded-for': ['10.0.0.1', '10.0.0.2'],
        },
        auth: undefined,
        ip: undefined,
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request);
      expect(key).toBe('ip:10.0.0.1');
    });

    it('should skip API key when disabled', () => {
      const request = {
        headers: {
          'x-api-key': 'test-api-key',
        },
        auth: {
          userId: 'user:12345',
          method: 'jwt',
          scopes: [],
        },
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request, { useApiKey: false });
      expect(key).toBe('user:user:12345');
    });

    it('should return anonymous when fallback disabled', () => {
      const request = {
        headers: {},
        auth: undefined,
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const key = generateRateLimitKey(request, { fallbackToIp: false });
      expect(key).toBe('anonymous');
    });
  });

  describe('parseTimeWindow', () => {
    it('should parse seconds', () => {
      expect(parseTimeWindow('30 seconds')).toBe(30000);
      expect(parseTimeWindow('30 second')).toBe(30000);
      expect(parseTimeWindow('30 sec')).toBe(30000);
      expect(parseTimeWindow('30 s')).toBe(30000);
      expect(parseTimeWindow('30s')).toBe(30000);
    });

    it('should parse minutes', () => {
      expect(parseTimeWindow('5 minutes')).toBe(300000);
      expect(parseTimeWindow('5 minute')).toBe(300000);
      expect(parseTimeWindow('5 min')).toBe(300000);
      expect(parseTimeWindow('5 m')).toBe(300000);
      expect(parseTimeWindow('1 minute')).toBe(60000);
    });

    it('should parse hours', () => {
      expect(parseTimeWindow('1 hour')).toBe(3600000);
      expect(parseTimeWindow('2 hours')).toBe(7200000);
      expect(parseTimeWindow('1 h')).toBe(3600000);
    });

    it('should default to 1 minute for invalid input', () => {
      expect(parseTimeWindow('invalid')).toBe(60000);
      expect(parseTimeWindow('')).toBe(60000);
      expect(parseTimeWindow('5 days')).toBe(60000);
    });

    it('should be case insensitive', () => {
      expect(parseTimeWindow('5 MINUTES')).toBe(300000);
      expect(parseTimeWindow('5 Minutes')).toBe(300000);
    });
  });
});

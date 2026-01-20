import { describe, it, expect } from 'vitest';
import { ZodError, z } from 'zod';
import type { FastifyRequest, FastifyError } from 'fastify';
import {
  createErrorResponse,
  HttpError,
  Errors,
} from '../../../src/middleware/error-handler.js';
import { ErrorTypes } from '../../../src/types/index.js';

describe('error-handler', () => {
  const mockRequest = {
    url: '/test',
    correlationId: 'test-correlation-id',
  } as unknown as FastifyRequest;

  describe('createErrorResponse', () => {
    it('should handle ZodError', () => {
      const schema = z.object({
        email: z.string().email(),
        age: z.number().min(18),
      });

      try {
        schema.parse({ email: 'invalid', age: 10 });
      } catch (error) {
        const response = createErrorResponse(error as Error, mockRequest);

        expect(response.type).toBe(ErrorTypes.VALIDATION_ERROR);
        expect(response.title).toBe('Validation Error');
        expect(response.status).toBe(400);
        expect(response.errors).toBeDefined();
        expect(response.errors?.length).toBe(2);
        expect(response.traceId).toBe('test-correlation-id');
      }
    });

    it('should handle Fastify validation error', () => {
      const error = {
        code: 'FST_ERR_VALIDATION',
        message: 'Validation failed',
        validation: [
          {
            instancePath: '/body/email',
            message: 'must be a valid email',
            keyword: 'format',
          },
        ],
      } as unknown as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.VALIDATION_ERROR);
      expect(response.status).toBe(400);
      expect(response.errors).toBeDefined();
      expect(response.errors?.[0]?.field).toBe('body.email');
    });

    it('should handle error with statusCode', () => {
      const error = {
        statusCode: 404,
        message: 'Resource not found',
      } as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.NOT_FOUND);
      expect(response.title).toBe('Not Found');
      expect(response.status).toBe(404);
      expect(response.detail).toBe('Resource not found');
    });

    it('should handle generic Error', () => {
      const error = new Error('Something went wrong');

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.INTERNAL);
      expect(response.title).toBe('Internal Server Error');
      expect(response.status).toBe(500);
    });

    it('should handle 401 errors', () => {
      const error = {
        statusCode: 401,
        message: 'Invalid token',
      } as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.UNAUTHORIZED);
      expect(response.title).toBe('Unauthorized');
    });

    it('should handle 403 errors', () => {
      const error = {
        statusCode: 403,
        message: 'Access denied',
      } as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.FORBIDDEN);
      expect(response.title).toBe('Forbidden');
    });

    it('should handle 409 errors', () => {
      const error = {
        statusCode: 409,
        message: 'Conflict with current state',
      } as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.CONFLICT);
      expect(response.title).toBe('Conflict');
    });

    it('should handle 429 errors', () => {
      const error = {
        statusCode: 429,
        message: 'Rate limit exceeded',
      } as FastifyError;

      const response = createErrorResponse(error, mockRequest);

      expect(response.type).toBe(ErrorTypes.RATE_LIMITED);
      expect(response.title).toBe('Too Many Requests');
    });
  });

  describe('HttpError', () => {
    it('should create error with status code', () => {
      const error = new HttpError(400, 'Bad request');

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Bad request');
      expect(error.errorType).toBe(ErrorTypes.VALIDATION_ERROR);
      expect(error.name).toBe('HttpError');
    });

    it('should allow custom error type', () => {
      const error = new HttpError(400, 'Bad request', 'custom:error');

      expect(error.errorType).toBe('custom:error');
    });
  });

  describe('Errors factory', () => {
    it('should create badRequest error', () => {
      const error = Errors.badRequest('Invalid input');

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Invalid input');
      expect(error.errorType).toBe(ErrorTypes.VALIDATION_ERROR);
    });

    it('should create unauthorized error', () => {
      const error = Errors.unauthorized('No token');

      expect(error.statusCode).toBe(401);
      expect(error.errorType).toBe(ErrorTypes.UNAUTHORIZED);
    });

    it('should create forbidden error', () => {
      const error = Errors.forbidden('Access denied');

      expect(error.statusCode).toBe(403);
      expect(error.errorType).toBe(ErrorTypes.FORBIDDEN);
    });

    it('should create notFound error', () => {
      const error = Errors.notFound('Resource not found');

      expect(error.statusCode).toBe(404);
      expect(error.errorType).toBe(ErrorTypes.NOT_FOUND);
    });

    it('should create conflict error', () => {
      const error = Errors.conflict('Already exists');

      expect(error.statusCode).toBe(409);
      expect(error.errorType).toBe(ErrorTypes.CONFLICT);
    });

    it('should create internal error', () => {
      const error = Errors.internal('Server error');

      expect(error.statusCode).toBe(500);
      expect(error.errorType).toBe(ErrorTypes.INTERNAL);
    });
  });
});

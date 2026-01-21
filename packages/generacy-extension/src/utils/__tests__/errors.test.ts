/**
 * Tests for error handling utilities
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GeneracyError,
  ErrorCode,
  ok,
  err,
  trySync,
  tryAsync,
  assert,
  assertDefined,
} from '../errors';

// Mock VS Code API
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock('../logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    show: vi.fn(),
  }),
}));

describe('GeneracyError', () => {
  describe('constructor', () => {
    it('should create error with code and default message', () => {
      const error = new GeneracyError(ErrorCode.FileNotFound);
      expect(error.code).toBe(ErrorCode.FileNotFound);
      expect(error.message).toBe('File not found');
      expect(error.userMessage).toBe('File not found');
    });

    it('should create error with custom message', () => {
      const error = new GeneracyError(ErrorCode.FileNotFound, 'Custom message');
      expect(error.code).toBe(ErrorCode.FileNotFound);
      expect(error.message).toBe('Custom message');
      expect(error.userMessage).toBe('Custom message');
    });

    it('should create error with details', () => {
      const error = new GeneracyError(ErrorCode.FileNotFound, 'Not found', {
        details: { path: '/some/file.txt' },
      });
      expect(error.details).toEqual({ path: '/some/file.txt' });
    });

    it('should create error with cause', () => {
      const cause = new Error('Original error');
      const error = new GeneracyError(ErrorCode.FileReadError, 'Read failed', {
        cause,
      });
      expect(error.cause).toBe(cause);
    });
  });

  describe('from', () => {
    it('should return GeneracyError as-is', () => {
      const original = new GeneracyError(ErrorCode.ConfigInvalid);
      const result = GeneracyError.from(original);
      expect(result).toBe(original);
    });

    it('should wrap Error in GeneracyError', () => {
      const original = new Error('Some error');
      const result = GeneracyError.from(original, ErrorCode.Unknown);
      expect(result).toBeInstanceOf(GeneracyError);
      expect(result.cause).toBe(original);
      expect(result.message).toBe('Some error');
    });

    it('should wrap string in GeneracyError', () => {
      const result = GeneracyError.from('string error', ErrorCode.Unknown);
      expect(result).toBeInstanceOf(GeneracyError);
    });
  });

  describe('toDetailedString', () => {
    it('should include code and message', () => {
      const error = new GeneracyError(ErrorCode.FileNotFound, 'Not found');
      const detailed = error.toDetailedString();
      expect(detailed).toContain('[2001]');
      expect(detailed).toContain('Not found');
    });

    it('should include details if present', () => {
      const error = new GeneracyError(ErrorCode.FileNotFound, 'Not found', {
        details: { path: '/file.txt' },
      });
      const detailed = error.toDetailedString();
      expect(detailed).toContain('Details:');
      expect(detailed).toContain('/file.txt');
    });

    it('should include cause if present', () => {
      const cause = new Error('Cause message');
      const error = new GeneracyError(ErrorCode.FileNotFound, 'Not found', {
        cause,
      });
      const detailed = error.toDetailedString();
      expect(detailed).toContain('Caused by:');
      expect(detailed).toContain('Cause message');
    });
  });
});

describe('Result utilities', () => {
  describe('ok', () => {
    it('should create a success result', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });
  });

  describe('err', () => {
    it('should create an error result', () => {
      const error = new GeneracyError(ErrorCode.Unknown);
      const result = err(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
      }
    });
  });

  describe('trySync', () => {
    it('should return ok result on success', () => {
      const result = trySync(() => 42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('should return err result on failure', () => {
      const result = trySync(() => {
        throw new Error('Test error');
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(GeneracyError);
      }
    });
  });

  describe('tryAsync', () => {
    it('should return ok result on success', async () => {
      const result = await tryAsync(async () => 42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('should return err result on failure', async () => {
      const result = await tryAsync(async () => {
        throw new Error('Test error');
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(GeneracyError);
      }
    });
  });
});

describe('Assertion utilities', () => {
  describe('assert', () => {
    it('should not throw when condition is true', () => {
      expect(() => assert(true, ErrorCode.Unknown)).not.toThrow();
    });

    it('should throw GeneracyError when condition is false', () => {
      expect(() => assert(false, ErrorCode.ConfigInvalid)).toThrow(GeneracyError);
    });

    it('should include custom message in thrown error', () => {
      try {
        assert(false, ErrorCode.ConfigInvalid, 'Custom assertion message');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GeneracyError);
        expect((error as GeneracyError).message).toBe('Custom assertion message');
      }
    });
  });

  describe('assertDefined', () => {
    it('should return value when not null/undefined', () => {
      expect(assertDefined(42, ErrorCode.Unknown)).toBe(42);
      expect(assertDefined('string', ErrorCode.Unknown)).toBe('string');
      expect(assertDefined(0, ErrorCode.Unknown)).toBe(0);
      expect(assertDefined('', ErrorCode.Unknown)).toBe('');
      expect(assertDefined(false, ErrorCode.Unknown)).toBe(false);
    });

    it('should throw when value is null', () => {
      expect(() => assertDefined(null, ErrorCode.ConfigMissing)).toThrow(GeneracyError);
    });

    it('should throw when value is undefined', () => {
      expect(() => assertDefined(undefined, ErrorCode.ConfigMissing)).toThrow(GeneracyError);
    });
  });
});

describe('ErrorCode', () => {
  it('should have unique values', () => {
    const codes = Object.values(ErrorCode).filter((v) => typeof v === 'number');
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });

  it('should follow category numbering', () => {
    // Config errors: 1xxx
    expect(ErrorCode.ConfigInvalid).toBeGreaterThanOrEqual(1000);
    expect(ErrorCode.ConfigInvalid).toBeLessThan(2000);

    // File errors: 2xxx
    expect(ErrorCode.FileNotFound).toBeGreaterThanOrEqual(2000);
    expect(ErrorCode.FileNotFound).toBeLessThan(3000);

    // Workflow errors: 3xxx
    expect(ErrorCode.WorkflowInvalid).toBeGreaterThanOrEqual(3000);
    expect(ErrorCode.WorkflowInvalid).toBeLessThan(4000);

    // Auth errors: 4xxx
    expect(ErrorCode.AuthRequired).toBeGreaterThanOrEqual(4000);
    expect(ErrorCode.AuthRequired).toBeLessThan(5000);

    // API errors: 5xxx
    expect(ErrorCode.ApiConnectionError).toBeGreaterThanOrEqual(5000);
    expect(ErrorCode.ApiConnectionError).toBeLessThan(6000);

    // Debug errors: 6xxx
    expect(ErrorCode.DebugSessionError).toBeGreaterThanOrEqual(6000);
    expect(ErrorCode.DebugSessionError).toBeLessThan(7000);

    // General errors: 9xxx
    expect(ErrorCode.Unknown).toBeGreaterThanOrEqual(9000);
    expect(ErrorCode.Unknown).toBeLessThan(10000);
  });
});

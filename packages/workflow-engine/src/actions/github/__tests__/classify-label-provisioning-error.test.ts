/**
 * FR-004: Unit tests for the shared classifier.
 *
 * Covers the race pattern (both underscore and space forms), HTTP-status
 * extraction, the `Failed to create label <name>:` prefix strip, and non-Error
 * inputs.
 */
import { describe, it, expect } from 'vitest';
import { classifyLabelProvisioningError } from '../classify-label-provisioning-error.js';

describe('classifyLabelProvisioningError', () => {
  it('classifies "already exists" (space form) as a race', () => {
    const result = classifyLabelProvisioningError(new Error('label already exists'));
    expect(result).toEqual({ kind: 'already-exists' });
  });

  it('classifies "already_exists" (underscore form, REST API) as a race', () => {
    const result = classifyLabelProvisioningError(
      new Error('Failed to create label foo: label already_exists'),
    );
    expect(result).toEqual({ kind: 'already-exists' });
  });

  it('extracts statusCode 422 and description-too-long cause', () => {
    const result = classifyLabelProvisioningError(
      new Error(
        'HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)',
      ),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.statusCode).toBe(422);
      expect(result.cause).toContain('description is too long');
    }
  });

  it('extracts statusCode 401 for bad credentials', () => {
    const result = classifyLabelProvisioningError(new Error('HTTP 401: Bad credentials'));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.statusCode).toBe(401);
    }
  });

  it('extracts statusCode 403 for permission denied', () => {
    const result = classifyLabelProvisioningError(
      new Error('HTTP 403: Resource not accessible by integration'),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.statusCode).toBe(403);
    }
  });

  it('extracts statusCode 500 for server error', () => {
    const result = classifyLabelProvisioningError(new Error('HTTP 500: Internal Server Error'));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.statusCode).toBe(500);
    }
  });

  it('strips the "Failed to create label <name>: " prefix from the cause', () => {
    const result = classifyLabelProvisioningError(
      new Error(
        'Failed to create label foo: HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)',
      ),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.cause.startsWith('HTTP 422:')).toBe(true);
      expect(result.cause).not.toContain('Failed to create label foo:');
    }
  });

  it('handles non-Error inputs by stringifying them', () => {
    const result = classifyLabelProvisioningError('gone');
    expect(result).toEqual({ kind: 'error', cause: 'gone' });
  });

  it('handles null input', () => {
    const result = classifyLabelProvisioningError(null);
    expect(result).toEqual({ kind: 'error', cause: 'null' });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { resolveActingIdentity } from '../acting-identity.js';

interface MockLogger {
  info: Mock;
  error: Mock;
}

function createMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

describe('resolveActingIdentity (#874)', () => {
  const original = process.env['CLUSTER_ACTING_LOGIN'];

  beforeEach(() => {
    delete process.env['CLUSTER_ACTING_LOGIN'];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env['CLUSTER_ACTING_LOGIN'];
    } else {
      process.env['CLUSTER_ACTING_LOGIN'] = original;
    }
  });

  it('returns normalized value when env is set to bot login', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = 'generacy-ai';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBe('generacy-ai');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { actingLogin: 'generacy-ai', source: 'env' },
      'Acting identity resolved: generacy-ai (from CLUSTER_ACTING_LOGIN)',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lowercases display-case login', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = 'Generacy-AI';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBe('generacy-ai');
    expect(logger.info).toHaveBeenCalledWith(
      { actingLogin: 'generacy-ai', source: 'env' },
      'Acting identity resolved: generacy-ai (from CLUSTER_ACTING_LOGIN)',
    );
  });

  it('trims whitespace-wrapped value', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = '  generacy-ai  ';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBe('generacy-ai');
    expect(logger.info).toHaveBeenCalledWith(
      { actingLogin: 'generacy-ai', source: 'env' },
      'Acting identity resolved: generacy-ai (from CLUSTER_ACTING_LOGIN)',
    );
  });

  it('strips [bot] suffix', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = 'generacy-ai[bot]';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBe('generacy-ai');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns undefined when env is unset and emits FR-006 error line', () => {
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { triedChain: ['CLUSTER_ACTING_LOGIN'], outcome: 'unset-or-empty' },
      'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).',
    );
  });

  it('returns undefined when env is empty string and emits FR-006 error line', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = '';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { triedChain: ['CLUSTER_ACTING_LOGIN'], outcome: 'unset-or-empty' },
      'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).',
    );
  });

  it('returns undefined when env is whitespace-only', () => {
    process.env['CLUSTER_ACTING_LOGIN'] = '   ';
    const logger = createMockLogger();
    expect(resolveActingIdentity(logger)).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { triedChain: ['CLUSTER_ACTING_LOGIN'], outcome: 'unset-or-empty' },
      'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).',
    );
  });
});

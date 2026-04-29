import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkNodeVersion } from '../node-version.js';

describe('checkNodeVersion', () => {
  const originalNodeVersion = process.versions.node;

  afterEach(() => {
    Object.defineProperty(process.versions, 'node', {
      value: originalNodeVersion,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('should exit with code 1 when Node version is below minimum', () => {
    Object.defineProperty(process.versions, 'node', {
      value: '20.0.0',
      writable: true,
      configurable: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    checkNodeVersion(22);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://nodejs.org/en/download'),
    );
  });

  it('should pass without exiting when Node version meets minimum', () => {
    Object.defineProperty(process.versions, 'node', {
      value: '22.0.0',
      writable: true,
      configurable: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    checkNodeVersion(22);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should pass when Node version exceeds minimum', () => {
    Object.defineProperty(process.versions, 'node', {
      value: '24.0.0',
      writable: true,
      configurable: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    checkNodeVersion(22);

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

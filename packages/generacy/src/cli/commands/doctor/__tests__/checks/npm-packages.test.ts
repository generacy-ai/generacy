import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: node:fs and node:url
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock import.meta.url resolution for getExpectedVersion
vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/mocked/packages/generacy/src/cli/commands/doctor/checks'),
}));

import { existsSync, readFileSync } from 'node:fs';
import { npmPackagesCheck } from '../../checks/npm-packages.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    configPath: null,
    config: null,
    envVars: null,
    inDevContainer: false,
    verbose: false,
    projectRoot: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('npmPackagesCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(npmPackagesCheck.id).toBe('npm-packages');
    expect(npmPackagesCheck.category).toBe('packages');
    expect(npmPackagesCheck.dependencies).toEqual([]);
    expect(npmPackagesCheck.priority).toBe('P2');
  });

  // -------------------------------------------------------------------------
  // Failure: node_modules not found
  // -------------------------------------------------------------------------

  it('fails when node_modules directory does not exist', async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Packages not installed');
    expect(result.suggestion).toContain('pnpm install');
  });

  // -------------------------------------------------------------------------
  // Failure: package not installed
  // -------------------------------------------------------------------------

  it('fails when @generacy-ai/generacy is not in node_modules', async () => {
    // First call: node_modules exists; second call: package dir does not
    mockedExistsSync.mockImplementation((path: any) => {
      if (String(path).endsWith('node_modules')) return true;
      return false;
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('@generacy-ai/generacy is not installed');
    expect(result.suggestion).toContain('pnpm install');
  });

  // -------------------------------------------------------------------------
  // Failure: package.json read error
  // -------------------------------------------------------------------------

  it('fails when installed package.json cannot be read', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes('node_modules')) {
        throw new Error('EACCES: permission denied');
      }
      // Own package.json
      return JSON.stringify({ version: '1.0.0' });
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to read');
    expect(result.suggestion).toContain('pnpm install');
    expect(result.detail).toContain('EACCES');
  });

  // -------------------------------------------------------------------------
  // Warning: version mismatch (installed < expected)
  // -------------------------------------------------------------------------

  it('warns when installed version is older than expected', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes('node_modules')) {
        return JSON.stringify({ version: '0.9.0' });
      }
      // Own package.json (expected version)
      return JSON.stringify({ version: '1.0.0' });
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('Version mismatch');
    expect(result.message).toContain('0.9.0');
    expect(result.message).toContain('1.0.0');
    expect(result.suggestion).toContain('Update');
  });

  // -------------------------------------------------------------------------
  // Warning: no version field in installed package
  // -------------------------------------------------------------------------

  it('warns when installed package has no version field', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes('node_modules')) {
        return JSON.stringify({ name: '@generacy-ai/generacy' });
      }
      return JSON.stringify({ version: '1.0.0' });
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('no version field');
  });

  // -------------------------------------------------------------------------
  // Success: valid version (installed >= expected)
  // -------------------------------------------------------------------------

  it('passes when installed version matches expected', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes('node_modules')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      return JSON.stringify({ version: '1.0.0' });
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('@generacy-ai/generacy');
    expect(result.message).toContain('1.0.0');
  });

  it('passes when installed version is newer than expected', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes('node_modules')) {
        return JSON.stringify({ version: '2.0.0' });
      }
      return JSON.stringify({ version: '1.5.0' });
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('2.0.0');
  });

  // -------------------------------------------------------------------------
  // Fallback: own version unreadable
  // -------------------------------------------------------------------------

  it('passes with info when own package.json is unreadable', async () => {
    mockedExistsSync.mockReturnValue(true);

    mockedReadFileSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes('node_modules')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      // Own package.json — simulate read failure
      throw new Error('ENOENT');
    });

    const result = await npmPackagesCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('1.0.0');
    expect(result.detail).toContain('Could not determine expected version');
  });

  // -------------------------------------------------------------------------
  // Uses projectRoot or falls back to cwd
  // -------------------------------------------------------------------------

  it('uses process.cwd() when projectRoot is null', async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await npmPackagesCheck.run(makeContext());

    expect(result.status).toBe('fail');
    // Just verify it runs without crashing
    expect(result.message).toBe('Packages not installed');
  });
});

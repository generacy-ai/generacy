import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: node:fs
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { devcontainerCheck } from '../../checks/devcontainer.js';

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

describe('devcontainerCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(devcontainerCheck.id).toBe('devcontainer');
    expect(devcontainerCheck.category).toBe('system');
    expect(devcontainerCheck.dependencies).toEqual([]);
    expect(devcontainerCheck.priority).toBe('P2');
  });

  // -------------------------------------------------------------------------
  // Failure: devcontainer.json missing
  // -------------------------------------------------------------------------

  it('fails when devcontainer.json does not exist', async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('.devcontainer/devcontainer.json not found');
    expect(result.suggestion).toContain('generacy init');
    expect(result.detail).toContain('/project/.devcontainer/devcontainer.json');
  });

  it('uses process.cwd() when projectRoot is null', async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await devcontainerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    // Just verify it doesn't crash — the path will use cwd
    expect(result.message).toContain('.devcontainer/devcontainer.json not found');
  });

  // -------------------------------------------------------------------------
  // Failure: JSON parse error
  // -------------------------------------------------------------------------

  it('fails when devcontainer.json has invalid JSON', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('{ invalid json }');

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to parse devcontainer.json');
    expect(result.suggestion).toContain('JSON syntax');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Warning: missing Generacy feature
  // -------------------------------------------------------------------------

  it('warns when devcontainer.json exists but has no features', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
      }),
    );

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing Generacy feature');
    expect(result.suggestion).toContain(
      'ghcr.io/generacy-ai/generacy/generacy',
    );
  });

  it('warns when features exist but without Generacy feature', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        features: {
          'ghcr.io/devcontainers/features/node:1': {},
          'ghcr.io/devcontainers/features/docker-in-docker:2': {},
        },
      }),
    );

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing Generacy feature');
  });

  // -------------------------------------------------------------------------
  // Success: valid devcontainer with Generacy feature
  // -------------------------------------------------------------------------

  it('passes when Generacy feature is present', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        features: {
          'ghcr.io/generacy-ai/generacy/generacy': {},
        },
      }),
    );

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('Generacy feature');
  });

  it('passes when Generacy feature has a version tag', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        features: {
          'ghcr.io/generacy-ai/generacy/generacy:1.0.0': { option: true },
          'ghcr.io/devcontainers/features/node:1': {},
        },
      }),
    );

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('Generacy feature');
  });

  // -------------------------------------------------------------------------
  // Edge case: features field is not an object
  // -------------------------------------------------------------------------

  it('warns when features field is a non-object value', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        features: 'not-an-object',
      }),
    );

    const result = await devcontainerCheck.run(
      makeContext({ projectRoot: '/project' }),
    );

    // String is typeof 'object' === false, so falls through to warning
    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing Generacy feature');
  });
});

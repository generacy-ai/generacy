import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: node:fs and dotenv
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('dotenv', () => ({
  parse: vi.fn(),
}));

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { envFileCheck } from '../../checks/env-file.js';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedParseDotenv = vi.mocked(parseDotenv);

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

describe('envFileCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(envFileCheck.id).toBe('env-file');
    expect(envFileCheck.category).toBe('config');
    expect(envFileCheck.dependencies).toEqual(['config']);
    expect(envFileCheck.priority).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // Skip: no configPath in context
  // -------------------------------------------------------------------------

  it('skips when configPath is null', async () => {
    const result = await envFileCheck.run(makeContext({ configPath: null }));

    expect(result.status).toBe('skip');
    expect(result.message).toContain('config path not available');
  });

  // -------------------------------------------------------------------------
  // Failure: env file not found
  // -------------------------------------------------------------------------

  it('fails when env file does not exist', async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Env file not found');
    expect(result.suggestion).toContain('generacy init');
    expect(result.suggestion).toContain('GITHUB_TOKEN');
    expect(result.suggestion).toContain('ANTHROPIC_API_KEY');
  });

  // -------------------------------------------------------------------------
  // Failure: missing required keys
  // -------------------------------------------------------------------------

  it('fails when required keys are missing', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('SOME_OTHER_KEY=value');
    mockedParseDotenv.mockReturnValue({ SOME_OTHER_KEY: 'value' });

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('missing required keys');
    expect(result.message).toContain('GITHUB_TOKEN');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
    expect(result.data).toEqual({
      envVars: { SOME_OTHER_KEY: 'value' },
    });
  });

  it('fails when only one required key is missing', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'GITHUB_TOKEN=ghp_token123\nSOME_KEY=value',
    );
    mockedParseDotenv.mockReturnValue({
      GITHUB_TOKEN: 'ghp_token123',
      SOME_KEY: 'value',
    });

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
    expect(result.message).not.toContain('GITHUB_TOKEN');
  });

  // -------------------------------------------------------------------------
  // Warning: empty values
  // -------------------------------------------------------------------------

  it('warns when required keys have empty values', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'GITHUB_TOKEN=\nANTHROPIC_API_KEY=   ',
    );
    mockedParseDotenv.mockReturnValue({
      GITHUB_TOKEN: '',
      ANTHROPIC_API_KEY: '   ',
    });

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('empty values');
    expect(result.message).toContain('GITHUB_TOKEN');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
    expect(result.data).toEqual({
      envVars: { GITHUB_TOKEN: '', ANTHROPIC_API_KEY: '   ' },
    });
  });

  it('warns when only one key has an empty value', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'GITHUB_TOKEN=ghp_token\nANTHROPIC_API_KEY=',
    );
    mockedParseDotenv.mockReturnValue({
      GITHUB_TOKEN: 'ghp_token',
      ANTHROPIC_API_KEY: '',
    });

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
    expect(result.message).not.toContain('GITHUB_TOKEN');
  });

  // -------------------------------------------------------------------------
  // Success: valid env file
  // -------------------------------------------------------------------------

  it('passes with valid env file containing all required keys', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'GITHUB_TOKEN=ghp_token123\nANTHROPIC_API_KEY=sk-ant-key123',
    );
    mockedParseDotenv.mockReturnValue({
      GITHUB_TOKEN: 'ghp_token123',
      ANTHROPIC_API_KEY: 'sk-ant-key123',
    });

    const result = await envFileCheck.run(
      makeContext({ configPath: '/project/.generacy/config.yaml' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('.generacy/generacy.env');
    expect(result.message).toContain('required keys');
    expect(result.data).toEqual({
      envVars: {
        GITHUB_TOKEN: 'ghp_token123',
        ANTHROPIC_API_KEY: 'sk-ant-key123',
      },
    });
  });

  // -------------------------------------------------------------------------
  // Env file path resolution
  // -------------------------------------------------------------------------

  it('resolves env file path relative to config directory', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      'GITHUB_TOKEN=tok\nANTHROPIC_API_KEY=key',
    );
    mockedParseDotenv.mockReturnValue({
      GITHUB_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
    });

    await envFileCheck.run(
      makeContext({ configPath: '/my/project/.generacy/config.yaml' }),
    );

    // existsSync should be called with the env path derived from configPath directory
    expect(mockedExistsSync).toHaveBeenCalledWith(
      '/my/project/.generacy/generacy.env',
    );
  });
});

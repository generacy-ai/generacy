import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError, ZodIssue } from 'zod';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: config loader
// ---------------------------------------------------------------------------

vi.mock('../../../../../config/index.js', () => ({
  findConfigFile: vi.fn(),
  loadConfig: vi.fn(),
  ConfigNotFoundError: class ConfigNotFoundError extends Error {
    startDir: string;
    searchPath: string[];
    constructor(startDir: string, searchPath: string[]) {
      super(`Config not found starting from ${startDir}`);
      this.name = 'ConfigNotFoundError';
      this.startDir = startDir;
      this.searchPath = searchPath;
    }
  },
  ConfigParseError: class ConfigParseError extends Error {
    filePath: string;
    cause: Error;
    constructor(filePath: string, cause: Error) {
      super(`Failed to parse config file: ${filePath}\n\n${cause.message}`);
      this.name = 'ConfigParseError';
      this.filePath = filePath;
      this.cause = cause;
    }
  },
  ConfigSchemaError: class ConfigSchemaError extends Error {
    filePath: string;
    errors: ZodError;
    constructor(filePath: string, errors: ZodError) {
      super(`Config schema validation failed: ${filePath}`);
      this.name = 'ConfigSchemaError';
      this.filePath = filePath;
      this.errors = errors;
    }
  },
  ConfigValidationError: class ConfigValidationError extends Error {
    conflictingRepos?: string[];
    locations?: string[];
    constructor(
      message: string,
      conflictingRepos?: string[],
      locations?: string[],
    ) {
      super(message);
      this.name = 'ConfigValidationError';
      this.conflictingRepos = conflictingRepos;
      this.locations = locations;
    }
  },
}));

import {
  findConfigFile,
  loadConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
  ConfigValidationError,
} from '../../../../../config/index.js';
import { configCheck } from '../../checks/config.js';

const mockedFindConfigFile = vi.mocked(findConfigFile);
const mockedLoadConfig = vi.mocked(loadConfig);

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

describe('configCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(configCheck.id).toBe('config');
    expect(configCheck.category).toBe('config');
    expect(configCheck.dependencies).toEqual([]);
    expect(configCheck.priority).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // Failure: config file not found (findConfigFile returns null)
  // -------------------------------------------------------------------------

  it('fails when findConfigFile returns null', async () => {
    mockedFindConfigFile.mockReturnValue(null);

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Config file not found');
    expect(result.suggestion).toContain('generacy init');
  });

  // -------------------------------------------------------------------------
  // Failure: ConfigNotFoundError from loadConfig
  // -------------------------------------------------------------------------

  it('fails with ConfigNotFoundError', async () => {
    mockedFindConfigFile.mockReturnValue('/project/.generacy/config.yaml');
    mockedLoadConfig.mockImplementation(() => {
      throw new ConfigNotFoundError('/project', ['/project/.generacy']);
    });

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Config file not found');
    expect(result.suggestion).toContain('generacy init');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure: ConfigParseError (invalid YAML)
  // -------------------------------------------------------------------------

  it('fails with ConfigParseError', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockImplementation(() => {
      throw new ConfigParseError(configPath, new Error('unexpected token'));
    });

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('invalid YAML syntax');
    expect(result.message).toContain(configPath);
    expect(result.suggestion).toContain('YAML syntax');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure: ConfigSchemaError (validation errors)
  // -------------------------------------------------------------------------

  it('fails with ConfigSchemaError', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);

    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'number',
        path: ['project', 'name'],
        message: 'Expected string, received number',
      } as ZodIssue,
    ]);
    mockedLoadConfig.mockImplementation(() => {
      throw new ConfigSchemaError(configPath, zodError);
    });

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('schema validation');
    expect(result.message).toContain(configPath);
    expect(result.suggestion).toContain('project.name');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure: ConfigValidationError (semantic errors)
  // -------------------------------------------------------------------------

  it('fails with ConfigValidationError', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockImplementation(() => {
      throw new ConfigValidationError('Duplicate repo names', [
        'repo-a',
        'repo-b',
      ]);
    });

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('semantic errors');
    expect(result.message).toContain(configPath);
    expect(result.suggestion).toContain('Duplicate repo names');
    expect(result.detail).toContain('repo-a');
    expect(result.detail).toContain('repo-b');
  });

  it('handles ConfigValidationError without conflictingRepos', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockImplementation(() => {
      throw new ConfigValidationError('Some semantic issue');
    });

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('semantic errors');
    expect(result.detail).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Failure: unexpected error re-thrown
  // -------------------------------------------------------------------------

  it('re-throws unexpected errors', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockImplementation(() => {
      throw new Error('unexpected kaboom');
    });

    await expect(configCheck.run(makeContext())).rejects.toThrow(
      'unexpected kaboom',
    );
  });

  // -------------------------------------------------------------------------
  // Success: config loaded successfully
  // -------------------------------------------------------------------------

  it('passes and populates context data on success', async () => {
    const configPath = '/project/.generacy/config.yaml';
    const fakeConfig = {
      project: { name: 'my-project', id: 'proj-123' },
    };

    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockReturnValue(fakeConfig as any);

    const result = await configCheck.run(makeContext());

    expect(result.status).toBe('pass');
    expect(result.message).toContain('Config file is valid');
    expect(result.message).toContain(configPath);
    expect(result.detail).toContain('my-project');
    expect(result.detail).toContain('proj-123');

    // Verify context data is populated for dependent checks
    expect(result.data).toEqual({
      configPath,
      projectRoot: '/project',
      config: fakeConfig,
    });
  });

  it('calls loadConfig with the found configPath', async () => {
    const configPath = '/project/.generacy/config.yaml';
    mockedFindConfigFile.mockReturnValue(configPath);
    mockedLoadConfig.mockReturnValue({
      project: { name: 'test', id: 'test-id' },
    } as any);

    await configCheck.run(makeContext());

    expect(mockedLoadConfig).toHaveBeenCalledWith({ configPath });
  });
});

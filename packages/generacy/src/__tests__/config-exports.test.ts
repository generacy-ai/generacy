import { describe, it, expect } from 'vitest';

/**
 * Integration test to verify that the config module exports work correctly
 * This test verifies the subpath export @generacy-ai/generacy/config
 */
describe('Config Module Exports', () => {
  it('should export all schema types', async () => {
    const configModule = await import('../config/index.js');

    // Verify schema exports
    expect(configModule.ProjectConfigSchema).toBeDefined();
    expect(configModule.ReposConfigSchema).toBeDefined();
    expect(configModule.DefaultsConfigSchema).toBeDefined();
    expect(configModule.OrchestratorSettingsSchema).toBeDefined();
    expect(configModule.GeneracyConfigSchema).toBeDefined();

    // Verify function exports
    expect(typeof configModule.validateConfig).toBe('function');
    expect(typeof configModule.validateNoDuplicateRepos).toBe('function');
    expect(typeof configModule.validateSemantics).toBe('function');

    // Verify loader function exports
    expect(typeof configModule.loadConfig).toBe('function');
    expect(typeof configModule.findConfigFile).toBe('function');
    expect(typeof configModule.parseConfig).toBe('function');

    // Verify error class exports
    expect(configModule.ConfigValidationError).toBeDefined();
    expect(configModule.ConfigNotFoundError).toBeDefined();
    expect(configModule.ConfigParseError).toBeDefined();
    expect(configModule.ConfigSchemaError).toBeDefined();
  });

  it('should validate a minimal config through exported functions', async () => {
    const { validateConfig, validateSemantics } = await import('../config/index.js');

    const minimalConfig = {
      project: {
        id: 'proj_test12345',
        name: 'Test Project',
      },
      repos: {
        primary: 'github.com/test/repo',
      },
    };

    const validatedConfig = validateConfig(minimalConfig);
    expect(validatedConfig.schemaVersion).toBe('1');
    expect(validatedConfig.project.id).toBe('proj_test12345');
    expect(validatedConfig.repos.primary).toBe('github.com/test/repo');

    // Should not throw for valid config
    expect(() => validateSemantics(validatedConfig)).not.toThrow();
  });

  it('should detect duplicate repositories through semantic validation', async () => {
    const { validateConfig, validateSemantics, ConfigValidationError } = await import('../config/index.js');

    const configWithDuplicates = {
      project: {
        id: 'proj_test12345',
        name: 'Test Project',
      },
      repos: {
        primary: 'github.com/test/repo',
        dev: ['github.com/test/repo'], // Duplicate!
      },
    };

    const validatedConfig = validateConfig(configWithDuplicates);

    expect(() => validateSemantics(validatedConfig)).toThrow(ConfigValidationError);
  });

  it('should export parseConfig function that validates YAML strings', async () => {
    const { parseConfig } = await import('../config/index.js');

    const yamlContent = `
project:
  id: "proj_test12345"
  name: "Test Project"
repos:
  primary: "github.com/test/main"
  dev:
    - "github.com/test/lib"
  clone:
    - "github.com/test/docs"
defaults:
  agent: "claude-code"
  baseBranch: "main"
orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
`;

    const config = parseConfig(yamlContent);

    expect(config.project.id).toBe('proj_test12345');
    expect(config.project.name).toBe('Test Project');
    expect(config.repos.primary).toBe('github.com/test/main');
    expect(config.repos.dev).toEqual(['github.com/test/lib']);
    expect(config.repos.clone).toEqual(['github.com/test/docs']);
    expect(config.defaults?.agent).toBe('claude-code');
    expect(config.defaults?.baseBranch).toBe('main');
    expect(config.orchestrator?.pollIntervalMs).toBe(5000);
    expect(config.orchestrator?.workerCount).toBe(3);
  });

  it('should throw ConfigParseError for invalid YAML', async () => {
    const { parseConfig, ConfigParseError } = await import('../config/index.js');

    const invalidYaml = `
project:
  id: "proj_test
  name: "Missing closing quote
`;

    expect(() => parseConfig(invalidYaml)).toThrow(ConfigParseError);
  });

  it('should throw ConfigSchemaError for schema violations', async () => {
    const { parseConfig, ConfigSchemaError } = await import('../config/index.js');

    const invalidSchema = `
project:
  id: "invalid"
  name: "Test"
repos:
  primary: "github.com/test/main"
`;

    expect(() => parseConfig(invalidSchema)).toThrow(ConfigSchemaError);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Integration tests for @generacy-ai/generacy package exports
 *
 * These tests verify that the package's subpath exports work correctly
 * from a consumer's perspective, testing the actual package.json exports.
 */

describe('Package Exports Integration', () => {
  describe('Main export (@generacy-ai/generacy)', () => {
    it('should export main package entry point', async () => {
      // Import from the package entry point
      const mainModule = await import('@generacy-ai/generacy');

      // Main export should exist
      expect(mainModule).toBeDefined();
    });
  });

  describe('Config subpath export (@generacy-ai/generacy/config)', () => {
    it('should export all schema types and validators', async () => {
      // Import from the /config subpath export
      const configModule = await import('@generacy-ai/generacy/config');

      // Schema exports
      expect(configModule.ProjectConfigSchema).toBeDefined();
      expect(configModule.ReposConfigSchema).toBeDefined();
      expect(configModule.DefaultsConfigSchema).toBeDefined();
      expect(configModule.OrchestratorSettingsSchema).toBeDefined();
      expect(configModule.GeneracyConfigSchema).toBeDefined();

      // Validator function exports
      expect(typeof configModule.validateConfig).toBe('function');
      expect(typeof configModule.validateNoDuplicateRepos).toBe('function');
      expect(typeof configModule.validateSemantics).toBe('function');

      // Loader function exports
      expect(typeof configModule.loadConfig).toBe('function');
      expect(typeof configModule.findConfigFile).toBe('function');
      expect(typeof configModule.parseConfig).toBe('function');

      // Error class exports
      expect(configModule.ConfigValidationError).toBeDefined();
      expect(configModule.ConfigNotFoundError).toBeDefined();
      expect(configModule.ConfigParseError).toBeDefined();
      expect(configModule.ConfigSchemaError).toBeDefined();
    });

    it('should validate minimal config using exported schemas', async () => {
      const { validateConfig, GeneracyConfigSchema } = await import('@generacy-ai/generacy/config');

      const minimalConfig = {
        project: {
          id: 'proj_test12345',
          name: 'Test Project',
        },
        repos: {
          primary: 'github.com/test/main-repo',
        },
      };

      // Schema validation should work
      const schemaResult = GeneracyConfigSchema.safeParse(minimalConfig);
      expect(schemaResult.success).toBe(true);

      // validateConfig should return validated config with defaults
      const validatedConfig = validateConfig(minimalConfig);
      expect(validatedConfig.schemaVersion).toBe('1');
      expect(validatedConfig.project.id).toBe('proj_test12345');
      expect(validatedConfig.project.name).toBe('Test Project');
      expect(validatedConfig.repos.primary).toBe('github.com/test/main-repo');
    });

    it('should validate full config with all optional fields', async () => {
      const { validateConfig } = await import('@generacy-ai/generacy/config');

      const fullConfig = {
        project: {
          id: 'proj_full12345',
          name: 'Full Test Project',
        },
        repos: {
          primary: 'github.com/acme/main-api',
          dev: [
            'github.com/acme/shared-lib',
            'github.com/acme/worker-service',
          ],
          clone: [
            'github.com/acme/design-system',
            'github.com/public/api-docs',
          ],
        },
        defaults: {
          agent: 'claude-code',
          baseBranch: 'main',
        },
        orchestrator: {
          pollIntervalMs: 5000,
          workerCount: 3,
        },
      };

      const validatedConfig = validateConfig(fullConfig);

      expect(validatedConfig.project.id).toBe('proj_full12345');
      expect(validatedConfig.repos.dev).toEqual([
        'github.com/acme/shared-lib',
        'github.com/acme/worker-service',
      ]);
      expect(validatedConfig.repos.clone).toEqual([
        'github.com/acme/design-system',
        'github.com/public/api-docs',
      ]);
      expect(validatedConfig.defaults?.agent).toBe('claude-code');
      expect(validatedConfig.defaults?.baseBranch).toBe('main');
      expect(validatedConfig.orchestrator?.pollIntervalMs).toBe(5000);
      expect(validatedConfig.orchestrator?.workerCount).toBe(3);
    });

    it('should detect schema violations', async () => {
      const { validateConfig } = await import('@generacy-ai/generacy/config');

      const invalidConfig = {
        project: {
          id: 'invalid', // Too short - must match proj_[a-z0-9]{8,}
          name: 'Test Project',
        },
        repos: {
          primary: 'github.com/test/repo',
        },
      };

      // validateConfig throws ZodError directly, not ConfigSchemaError
      expect(() => validateConfig(invalidConfig)).toThrow();
    });

    it('should detect duplicate repositories across lists', async () => {
      const { validateConfig, validateSemantics, ConfigValidationError } =
        await import('@generacy-ai/generacy/config');

      const configWithDuplicates = {
        project: {
          id: 'proj_test12345',
          name: 'Test Project',
        },
        repos: {
          primary: 'github.com/acme/main-api',
          dev: [
            'github.com/acme/shared-lib',
            'github.com/acme/main-api', // Duplicate of primary
          ],
        },
      };

      const validatedConfig = validateConfig(configWithDuplicates);

      expect(() => validateSemantics(validatedConfig)).toThrow(ConfigValidationError);
      expect(() => validateSemantics(validatedConfig)).toThrow(/duplicate/i);
    });

    it('should parse YAML string into validated config', async () => {
      const { parseConfig } = await import('@generacy-ai/generacy/config');

      const yamlContent = `
project:
  id: "proj_yaml12345"
  name: "YAML Test Project"
repos:
  primary: "github.com/test/main"
  dev:
    - "github.com/test/lib-a"
    - "github.com/test/lib-b"
  clone:
    - "github.com/test/docs"
defaults:
  agent: "claude-code"
  baseBranch: "develop"
orchestrator:
  pollIntervalMs: 5000
  workerCount: 2
`;

      const config = parseConfig(yamlContent);

      expect(config.project.id).toBe('proj_yaml12345');
      expect(config.project.name).toBe('YAML Test Project');
      expect(config.repos.primary).toBe('github.com/test/main');
      expect(config.repos.dev).toEqual([
        'github.com/test/lib-a',
        'github.com/test/lib-b',
      ]);
      expect(config.repos.clone).toEqual(['github.com/test/docs']);
      expect(config.defaults?.agent).toBe('claude-code');
      expect(config.defaults?.baseBranch).toBe('develop');
      expect(config.orchestrator?.pollIntervalMs).toBe(5000);
      expect(config.orchestrator?.workerCount).toBe(2);
    });

    it('should throw ConfigParseError for malformed YAML', async () => {
      const { parseConfig, ConfigParseError } = await import('@generacy-ai/generacy/config');

      const malformedYaml = `
project:
  id: "proj_test12345
  name: "Missing closing quote
repos:
  primary: "github.com/test/main"
`;

      expect(() => parseConfig(malformedYaml)).toThrow(ConfigParseError);
    });

    it('should throw ConfigSchemaError for invalid schema in YAML', async () => {
      const { parseConfig, ConfigSchemaError } = await import('@generacy-ai/generacy/config');

      const invalidSchemaYaml = `
project:
  id: "short"
  name: "Test"
repos:
  primary: "github.com/test/main"
`;

      expect(() => parseConfig(invalidSchemaYaml)).toThrow(ConfigSchemaError);
    });
  });

  describe('Config file loading integration', () => {
    let tempDir: string;

    beforeEach(async () => {
      // Create a temporary directory for test files
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generacy-test-'));
    });

    afterEach(async () => {
      // Clean up temporary directory
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should find and load config from .generacy/config.yaml', async () => {
      const { loadConfig, findConfigFile } = await import('@generacy-ai/generacy/config');

      // Create .generacy directory and config file
      const generacyDir = path.join(tempDir, '.generacy');
      await fs.mkdir(generacyDir);

      const configPath = path.join(generacyDir, 'config.yaml');
      const configContent = `
project:
  id: "proj_findtest1"
  name: "Find Test Project"
repos:
  primary: "github.com/test/find-repo"
defaults:
  agent: "claude-code"
  baseBranch: "main"
`;
      await fs.writeFile(configPath, configContent, 'utf-8');

      // Test findConfigFile
      const foundPath = findConfigFile(tempDir);
      expect(foundPath).toBe(configPath);

      // Test loadConfig
      const config = loadConfig({ startDir: tempDir });
      expect(config.project.id).toBe('proj_findtest1');
      expect(config.project.name).toBe('Find Test Project');
      expect(config.repos.primary).toBe('github.com/test/find-repo');
      expect(config.defaults?.agent).toBe('claude-code');
    });

    it('should walk up parent directories to find config', async () => {
      const { findConfigFile } = await import('@generacy-ai/generacy/config');

      // Create nested directory structure
      const nestedDir = path.join(tempDir, 'level1', 'level2', 'level3');
      await fs.mkdir(nestedDir, { recursive: true });

      // Place config in root .generacy directory
      const generacyDir = path.join(tempDir, '.generacy');
      await fs.mkdir(generacyDir);

      const configPath = path.join(generacyDir, 'config.yaml');
      const configContent = `
project:
  id: "proj_walkup123"
  name: "Walk Up Test"
repos:
  primary: "github.com/test/walkup"
`;
      await fs.writeFile(configPath, configContent, 'utf-8');

      // Search from nested directory - should find config in ancestor
      const foundPath = findConfigFile(nestedDir);
      expect(foundPath).toBe(configPath);
    });

    it('should throw ConfigNotFoundError when no config exists', async () => {
      const { loadConfig, ConfigNotFoundError } = await import('@generacy-ai/generacy/config');

      // Create a unique temp directory that won't have a config
      const emptyDir = path.join(tempDir, 'definitely-empty-' + Date.now());
      await fs.mkdir(emptyDir, { recursive: true });

      // Create a .git file to stop the upward search
      await fs.writeFile(path.join(emptyDir, '.git'), '', 'utf-8');

      // Try to load from empty directory
      expect(() => loadConfig({ startDir: emptyDir })).toThrow(ConfigNotFoundError);
    });

    it('should validate config during load', async () => {
      const { loadConfig, ConfigSchemaError } = await import('@generacy-ai/generacy/config');

      // Create config with invalid schema
      const generacyDir = path.join(tempDir, '.generacy');
      await fs.mkdir(generacyDir);

      const configPath = path.join(generacyDir, 'config.yaml');
      const invalidConfig = `
project:
  id: "bad"
  name: "Invalid Project"
repos:
  primary: "github.com/test/repo"
`;
      await fs.writeFile(configPath, invalidConfig, 'utf-8');

      // Should throw schema error during load
      expect(() => loadConfig({ startDir: tempDir })).toThrow(ConfigSchemaError);
    });

    it('should validate semantics during load by default', async () => {
      const { loadConfig, ConfigValidationError } = await import('@generacy-ai/generacy/config');

      // Create config with duplicate repos
      const generacyDir = path.join(tempDir, '.generacy');
      await fs.mkdir(generacyDir);

      const configPath = path.join(generacyDir, 'config.yaml');
      const duplicateConfig = `
project:
  id: "proj_dup12345"
  name: "Duplicate Test"
repos:
  primary: "github.com/test/main"
  dev:
    - "github.com/test/main"
`;
      await fs.writeFile(configPath, duplicateConfig, 'utf-8');

      // Should throw validation error for duplicates
      expect(() => loadConfig({ startDir: tempDir })).toThrow(ConfigValidationError);
    });

    it('should always run semantic validation during load', async () => {
      const { loadConfig, ConfigValidationError } = await import('@generacy-ai/generacy/config');

      // Create config with duplicate repos
      const generacyDir = path.join(tempDir, '.generacy');
      await fs.mkdir(generacyDir);

      const configPath = path.join(generacyDir, 'config.yaml');
      const duplicateConfig = `
project:
  id: "proj_always123"
  name: "Always Validate Test"
repos:
  primary: "github.com/test/main"
  dev:
    - "github.com/test/main"
`;
      await fs.writeFile(configPath, duplicateConfig, 'utf-8');

      // loadConfig always runs semantic validation
      expect(() => loadConfig({ startDir: tempDir })).toThrow(ConfigValidationError);
    });
  });

  describe('Type exports', () => {
    it('should export TypeScript types for type-safe usage', async () => {
      // This test verifies that types are exported correctly
      // TypeScript will fail to compile if types are not exported

      const configModule = await import('@generacy-ai/generacy/config');

      // Test that we can use the types (TypeScript compilation test)
      const projectConfig: typeof configModule.ProjectConfig = {
        id: 'proj_type12345',
        name: 'Type Test',
      };

      expect(projectConfig.id).toBe('proj_type12345');

      const reposConfig: typeof configModule.ReposConfig = {
        primary: 'github.com/test/repo',
      };

      expect(reposConfig.primary).toBe('github.com/test/repo');

      const fullConfig: typeof configModule.GeneracyConfig = {
        schemaVersion: '1',
        project: projectConfig,
        repos: reposConfig,
      };

      expect(fullConfig.schemaVersion).toBe('1');
    });
  });

  describe('Error handling', () => {
    it('should provide detailed error messages for schema violations', async () => {
      const { validateConfig } = await import('@generacy-ai/generacy/config');

      const badConfig = {
        project: {
          id: 'x', // Too short
          name: 'Test',
        },
        repos: {
          primary: 'invalid-format', // Invalid repo format
        },
      };

      try {
        validateConfig(badConfig);
        expect.fail('Should have thrown an error');
      } catch (error) {
        // validateConfig throws ZodError directly
        expect(error).toBeDefined();
        expect(error.message).toBeDefined();
      }
    });

    it('should provide clear error messages for duplicate repos', async () => {
      const { validateConfig, validateSemantics, ConfigValidationError } =
        await import('@generacy-ai/generacy/config');

      const dupConfig = {
        project: {
          id: 'proj_err12345',
          name: 'Error Test',
        },
        repos: {
          primary: 'github.com/test/dup',
          dev: ['github.com/test/dup'],
        },
      };

      const validated = validateConfig(dupConfig);

      try {
        validateSemantics(validated);
        expect.fail('Should have thrown ConfigValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect(error.message).toMatch(/duplicate.*repositories/i);
      }
    });
  });

  describe('Real-world config examples', () => {
    it('should validate single-repo minimal config', async () => {
      const { parseConfig } = await import('@generacy-ai/generacy/config');

      const minimalYaml = `
project:
  id: "proj_minimal01"
  name: "Minimal Single Repo"
repos:
  primary: "github.com/user/single-repo"
`;

      const config = parseConfig(minimalYaml);
      expect(config.project.id).toBe('proj_minimal01');
      expect(config.repos.primary).toBe('github.com/user/single-repo');
      // Optional arrays default to empty arrays, not undefined
      expect(config.repos.dev).toEqual([]);
      expect(config.repos.clone).toEqual([]);
    });

    it('should validate multi-repo development config', async () => {
      const { parseConfig } = await import('@generacy-ai/generacy/config');

      const multiRepoYaml = `
project:
  id: "proj_multi0123"
  name: "Multi-Repo Project"
repos:
  primary: "github.com/acme/api-gateway"
  dev:
    - "github.com/acme/auth-service"
    - "github.com/acme/user-service"
    - "github.com/acme/shared-types"
  clone:
    - "github.com/acme/documentation"
    - "github.com/acme/design-assets"
defaults:
  agent: "claude-code"
  baseBranch: "develop"
orchestrator:
  pollIntervalMs: 5000
  workerCount: 5
`;

      const config = parseConfig(multiRepoYaml);
      expect(config.project.name).toBe('Multi-Repo Project');
      expect(config.repos.dev).toHaveLength(3);
      expect(config.repos.clone).toHaveLength(2);
      expect(config.defaults?.baseBranch).toBe('develop');
      expect(config.orchestrator?.workerCount).toBe(5);
    });
  });
});

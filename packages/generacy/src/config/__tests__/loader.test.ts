import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  findConfigFile,
  parseConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
} from '../loader.js';
import { ConfigValidationError } from '../validator.js';

describe('findConfigFile', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory in tmpdir
    testDir = join(tmpdir(), `generacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should find config in current directory', () => {
    // Create .generacy/config.yaml
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), 'test: true');

    const found = findConfigFile(testDir);
    expect(found).toBe(join(testDir, '.generacy', 'config.yaml'));
  });

  it('should find config in parent directory', () => {
    // Create .generacy/config.yaml in parent
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), 'test: true');

    // Search from child directory
    const childDir = join(testDir, 'child');
    mkdirSync(childDir);

    const found = findConfigFile(childDir);
    expect(found).toBe(join(testDir, '.generacy', 'config.yaml'));
  });

  it('should find config in grandparent directory', () => {
    // Create .generacy/config.yaml in grandparent
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), 'test: true');

    // Search from grandchild directory
    const childDir = join(testDir, 'child', 'grandchild');
    mkdirSync(childDir, { recursive: true });

    const found = findConfigFile(childDir);
    expect(found).toBe(join(testDir, '.generacy', 'config.yaml'));
  });

  it('should stop at repository root (.git/)', () => {
    // Create .git directory (repository root)
    const gitDir = join(testDir, '.git');
    mkdirSync(gitDir);

    // Create config above repository root
    const parentDir = join(testDir, '..');
    const parentConfigDir = join(parentDir, '.generacy');
    if (!existsSync(parentConfigDir)) {
      mkdirSync(parentConfigDir, { recursive: true });
    }
    writeFileSync(join(parentConfigDir, 'config.yaml'), 'test: true');

    // Should not find config above .git
    const found = findConfigFile(testDir);
    expect(found).toBeNull();
  });

  it('should return null if config not found', () => {
    // Create .git directory to stop at repo root
    const gitDir = join(testDir, '.git');
    mkdirSync(gitDir);

    const found = findConfigFile(testDir);
    expect(found).toBeNull();
  });
});

describe('parseConfig', () => {
  it('should parse valid minimal config', () => {
    const yaml = `
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
`;

    const config = parseConfig(yaml);
    expect(config.project.id).toBe('proj_test123');
    expect(config.project.name).toBe('Test Project');
    expect(config.repos.primary).toBe('github.com/test/repo');
  });

  it('should parse valid full config', () => {
    const yaml = `
schemaVersion: "1"
project:
  id: "proj_abc123xyz"
  name: "My Full Project"
repos:
  primary: "github.com/acme/main-api"
  dev:
    - "github.com/acme/shared-lib"
    - "github.com/acme/worker-service"
  clone:
    - "github.com/acme/design-system"
    - "github.com/public/api-docs"
defaults:
  agent: claude-code
  baseBranch: main
orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
`;

    const config = parseConfig(yaml);
    expect(config.schemaVersion).toBe('1');
    expect(config.project.id).toBe('proj_abc123xyz');
    expect(config.repos.dev).toEqual([
      'github.com/acme/shared-lib',
      'github.com/acme/worker-service',
    ]);
    expect(config.defaults?.agent).toBe('claude-code');
    expect(config.orchestrator?.pollIntervalMs).toBe(5000);
  });

  it('should throw ConfigParseError for invalid YAML', () => {
    const yaml = `
project:
  id: "proj_test123"
  invalid yaml: [unclosed
`;

    expect(() => parseConfig(yaml)).toThrow(ConfigParseError);
  });

  it('should throw ConfigSchemaError for invalid schema', () => {
    const yaml = `
project:
  id: "invalid_id"  # Must start with proj_
  name: "Test"
repos:
  primary: "github.com/test/repo"
`;

    expect(() => parseConfig(yaml)).toThrow(ConfigSchemaError);
  });

  it('should throw ConfigValidationError for duplicate repos', () => {
    const yaml = `
project:
  id: "proj_test123"
  name: "Test"
repos:
  primary: "github.com/test/repo"
  dev:
    - "github.com/test/shared"
  clone:
    - "github.com/test/shared"  # Duplicate
`;

    expect(() => parseConfig(yaml)).toThrow(ConfigValidationError);
  });

  it('should default schemaVersion to "1"', () => {
    const yaml = `
project:
  id: "proj_test123"
  name: "Test"
repos:
  primary: "github.com/test/repo"
`;

    const config = parseConfig(yaml);
    expect(config.schemaVersion).toBe('1');
  });
});

describe('loadConfig', () => {
  let testDir: string;
  const originalEnv = process.env.GENERACY_CONFIG_PATH;

  beforeEach(() => {
    testDir = join(tmpdir(), `generacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    // Restore env var
    if (originalEnv) {
      process.env.GENERACY_CONFIG_PATH = originalEnv;
    } else {
      delete process.env.GENERACY_CONFIG_PATH;
    }
  });

  it('should load valid config from discovered file', () => {
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);

    const configContent = `
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(join(configDir, 'config.yaml'), configContent);

    const config = loadConfig({ startDir: testDir });
    expect(config.project.id).toBe('proj_test123');
    expect(config.project.name).toBe('Test Project');
  });

  it('should load config from explicit path', () => {
    const configPath = join(testDir, 'custom-config.yaml');
    const configContent = `
project:
  id: "proj_custom123"
  name: "Custom Config"
repos:
  primary: "github.com/test/custom"
`;
    writeFileSync(configPath, configContent);

    const config = loadConfig({ configPath });
    expect(config.project.id).toBe('proj_custom123');
  });

  it('should prioritize GENERACY_CONFIG_PATH env var', () => {
    // Create config at env var path
    const envConfigPath = join(testDir, 'env-config.yaml');
    const envContent = `
project:
  id: "proj_env123456"
  name: "Env Config"
repos:
  primary: "github.com/test/env"
`;
    writeFileSync(envConfigPath, envContent);

    // Create config at discovered path
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);
    const discoveredContent = `
project:
  id: "proj_discovered"
  name: "Discovered Config"
repos:
  primary: "github.com/test/discovered"
`;
    writeFileSync(join(configDir, 'config.yaml'), discoveredContent);

    // Set env var
    process.env.GENERACY_CONFIG_PATH = envConfigPath;

    const config = loadConfig({ startDir: testDir });
    expect(config.project.id).toBe('proj_env123456');
  });

  it('should throw ConfigNotFoundError when config not found', () => {
    // Create .git directory to stop at repo root
    const gitDir = join(testDir, '.git');
    mkdirSync(gitDir);

    expect(() => loadConfig({ startDir: testDir })).toThrow(ConfigNotFoundError);
  });

  it('should throw ConfigNotFoundError with search path', () => {
    // Create .git directory to stop at repo root
    const gitDir = join(testDir, '.git');
    mkdirSync(gitDir);

    try {
      loadConfig({ startDir: testDir });
      expect.fail('Should have thrown ConfigNotFoundError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigNotFoundError);
      const configError = error as ConfigNotFoundError;
      expect(configError.searchPath.length).toBeGreaterThan(0);
      expect(configError.message).toContain('Searched in:');
    }
  });

  it('should throw ConfigSchemaError for invalid config', () => {
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);

    const invalidContent = `
project:
  id: "bad"  # Too short
  name: "Test"
repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(join(configDir, 'config.yaml'), invalidContent);

    expect(() => loadConfig({ startDir: testDir })).toThrow(ConfigSchemaError);
  });

  it('should throw ConfigValidationError for semantic errors', () => {
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);

    const semanticErrorContent = `
project:
  id: "proj_test123"
  name: "Test"
repos:
  primary: "github.com/test/repo"
  dev:
    - "github.com/test/repo"  # Duplicate with primary
`;
    writeFileSync(join(configDir, 'config.yaml'), semanticErrorContent);

    expect(() => loadConfig({ startDir: testDir })).toThrow(ConfigValidationError);
  });

  it('should find config in parent from nested directory', () => {
    const configDir = join(testDir, '.generacy');
    mkdirSync(configDir);

    const configContent = `
project:
  id: "proj_parent123"
  name: "Parent Config"
repos:
  primary: "github.com/test/parent"
`;
    writeFileSync(join(configDir, 'config.yaml'), configContent);

    // Load from nested directory
    const nestedDir = join(testDir, 'nested', 'deep');
    mkdirSync(nestedDir, { recursive: true });

    const config = loadConfig({ startDir: nestedDir });
    expect(config.project.id).toBe('proj_parent123');
  });
});

/**
 * Tests for the validate CLI command
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('validate CLI command', () => {
  let testDir: string;
  const cliPath = join(__dirname, '../../../bin/generacy.js');

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = mkdtempSync(join(tmpdir(), 'generacy-test-'));
  });

  afterEach(() => {
    // Clean up the temporary directory
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should validate a valid minimal config and return exit code 0', () => {
    const configPath = join(testDir, 'config.yaml');
    const validConfig = `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, validConfig);

    // Should not throw (exit code 0)
    const result = execSync(`node ${cliPath} validate ${configPath} --quiet`, {
      encoding: 'utf-8',
    });

    // Verify success message is printed to stdout
    expect(result.trim()).toBe('✓ Valid');
  });

  it('should validate a valid full config', () => {
    const configPath = join(testDir, 'config.yaml');
    const fullConfig = `
project:
  id: "proj_complete123"
  name: "Complete Example"

repos:
  primary: "github.com/example/main"
  dev:
    - "github.com/example/lib"
  clone:
    - "github.com/example/docs"

defaults:
  agent: claude-code
  baseBranch: main

orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
`;
    writeFileSync(configPath, fullConfig);

    const result = execSync(`node ${cliPath} validate ${configPath} --quiet`, {
      encoding: 'utf-8',
    });

    expect(result.trim()).toBe('✓ Valid');
  });

  it('should reject config with invalid project ID and return exit code 1', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidConfig = `
project:
  id: "invalid"
  name: "Test"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, invalidConfig);

    // Should throw (exit code 1)
    let error: any;
    try {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    } catch (e) {
      error = e;
    }

    // Verify exit code is 1
    expect(error).toBeDefined();
    expect(error.status).toBe(1);

    // Verify error message is printed to stderr
    expect(error.stderr).toContain('Schema validation failed');
    expect(error.stderr).toContain('Project ID must match format');
  });

  it('should reject config with empty project name', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidConfig = `
project:
  id: "proj_test123"
  name: ""

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, invalidConfig);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should reject config with invalid repository URL', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidConfig = `
project:
  id: "proj_test123"
  name: "Test"

repos:
  primary: "not-a-valid-url"
`;
    writeFileSync(configPath, invalidConfig);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should reject config with duplicate repositories', () => {
    const configPath = join(testDir, 'config.yaml');
    const duplicateConfig = `
project:
  id: "proj_test123"
  name: "Test"

repos:
  primary: "github.com/test/repo"
  dev:
    - "github.com/test/repo"
`;
    writeFileSync(configPath, duplicateConfig);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should output JSON when --json flag is used', () => {
    const configPath = join(testDir, 'config.yaml');
    const validConfig = `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, validConfig);

    const result = execSync(`node ${cliPath} validate ${configPath} --json`, {
      encoding: 'utf-8',
    });

    const json = JSON.parse(result);
    expect(json.valid).toBe(true);
    expect(json.configPath).toBe(configPath);
    expect(json.config.project.id).toBe('proj_test123');
  });

  it('should output JSON error when --json flag is used with invalid config', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidConfig = `
project:
  id: "invalid"
  name: "Test"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, invalidConfig);

    let result: string;
    try {
      execSync(`node ${cliPath} validate ${configPath} --json`, {
        encoding: 'utf-8',
      });
    } catch (error: any) {
      result = error.stdout;
    }

    const json = JSON.parse(result!);
    expect(json.valid).toBe(false);
    expect(json.errorType).toBe('ConfigSchemaError');
    expect(json.error).toContain('Project ID must match format');
  });

  it('should auto-discover config file in .generacy directory', () => {
    const generacyDir = join(testDir, '.generacy');
    mkdirSync(generacyDir, { recursive: true });

    const configPath = join(generacyDir, 'config.yaml');
    const validConfig = `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, validConfig);

    const result = execSync(`node ${cliPath} validate --quiet`, {
      encoding: 'utf-8',
      cwd: testDir,
    });

    expect(result.trim()).toBe('✓ Valid');
  });

  it('should handle missing config file gracefully and return exit code 1', () => {
    const nonexistentPath = join(testDir, 'nonexistent.yaml');

    // Should throw (exit code 1)
    let error: any;
    try {
      execSync(`node ${cliPath} validate ${nonexistentPath}`, {
        encoding: 'utf-8',
      });
    } catch (e) {
      error = e;
    }

    // Verify exit code is 1
    expect(error).toBeDefined();
    expect(error.status).toBe(1);

    // Verify error message is printed to stderr
    expect(error.stderr).toContain('Config file not found');
  });

  it('should reject config with invalid YAML syntax', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidYaml = `
project:
  id: "proj_test123"
  name: "Test Project"
  invalid: [unclosed
`;
    writeFileSync(configPath, invalidYaml);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should validate agent name format', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidAgentConfig = `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"

defaults:
  agent: "Invalid_Agent"
`;
    writeFileSync(configPath, invalidAgentConfig);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should validate orchestrator settings', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidOrchestratorConfig = `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"

orchestrator:
  pollIntervalMs: 100
  workerCount: 0
`;
    writeFileSync(configPath, invalidOrchestratorConfig);

    expect(() => {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    }).toThrow();
  });

  it('should use --config flag to override config path', () => {
    // Create config in a non-standard location
    const customConfigPath = join(testDir, 'custom-config.yaml');
    const validConfig = `
project:
  id: "proj_custom123"
  name: "Custom Config Test"

repos:
  primary: "github.com/test/custom-repo"
`;
    writeFileSync(customConfigPath, validConfig);

    // Validate using explicit --config flag
    const result = execSync(`node ${cliPath} validate ${customConfigPath} --quiet`, {
      encoding: 'utf-8',
    });

    expect(result.trim()).toBe('✓ Valid');
  });

  it('should print success message to stdout when config is valid', () => {
    const configPath = join(testDir, 'config.yaml');
    const validConfig = `
project:
  id: "proj_stdout123"
  name: "Test stdout"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, validConfig);

    // Run without --quiet flag to see full output
    const result = execSync(`node ${cliPath} validate ${configPath}`, {
      encoding: 'utf-8',
    });

    // Verify success message is in stdout
    expect(result).toContain('✓ Configuration is valid');
    expect(result).toContain('Project:');
    expect(result).toContain('ID: proj_stdout123');
    expect(result).toContain('Name: Test stdout');
  });

  it('should print error message to stderr when config is invalid', () => {
    const configPath = join(testDir, 'config.yaml');
    const invalidConfig = `
project:
  id: "bad"
  name: "Test"

repos:
  primary: "github.com/test/repo"
`;
    writeFileSync(configPath, invalidConfig);

    let error: any;
    try {
      execSync(`node ${cliPath} validate ${configPath}`, {
        encoding: 'utf-8',
      });
    } catch (e) {
      error = e;
    }

    // Verify error message is in stderr
    expect(error.stderr).toContain('Schema validation failed');
    expect(error.stderr).toContain('Project ID must match format');
  });
});

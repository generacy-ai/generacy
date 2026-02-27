/**
 * Integration tests for the doctor CLI command.
 *
 * These tests run the CLI as a subprocess via `execSync`, following the same
 * pattern used by `validate.test.ts`. Network-dependent checks (github-token,
 * anthropic-key, agency-mcp) are skipped via `--skip` to keep tests fast and
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const cliPath = join(__dirname, '../../../bin/generacy.js');

/** Checks that hit the network or depend on the local machine state. */
const SKIP_EXTERNAL = [
  'docker',
  'github-token',
  'anthropic-key',
  'npm-packages',
  'agency-mcp',
  'devcontainer',
];

function skipExternalFlags(): string {
  return `--skip ${SKIP_EXTERNAL.join(' ')}`;
}

function runDoctor(
  args: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  return execSync(`node ${cliPath} doctor ${args}`, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', ...opts.env },
  });
}

function runDoctorRaw(
  args: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${cliPath} doctor ${args}`, {
      encoding: 'utf-8',
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      status: error.status ?? 1,
    };
  }
}

describe('doctor CLI command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'generacy-doctor-test-'));
    // Create .git so findConfigFile stops searching at this directory
    mkdirSync(join(testDir, '.git'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Valid setup
  // ---------------------------------------------------------------------------

  describe('valid setup', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );
    });

    it('should return exit code 0 when config and env checks pass', () => {
      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);

      expect(report.exitCode).toBe(0);
      expect(report.summary.failed).toBe(0);
      expect(report.checks).toHaveLength(2); // config + env-file
      expect(report.checks.every((c: any) => c.status === 'pass')).toBe(true);
    });

    it('should include config check as pass with valid config path', () => {
      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);
      const configEntry = report.checks.find((c: any) => c.id === 'config');

      expect(configEntry).toBeDefined();
      expect(configEntry.status).toBe('pass');
      expect(configEntry.message).toContain('Config file is valid');
      expect(configEntry.message).toContain('.generacy/config.yaml');
    });

    it('should include env-file check as pass', () => {
      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);
      const envEntry = report.checks.find((c: any) => c.id === 'env-file');

      expect(envEntry).toBeDefined();
      expect(envEntry.status).toBe('pass');
      expect(envEntry.message).toContain('present with required keys');
    });

    it('should output text with category headers and pass symbols', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });

      expect(result).toContain('Generacy Doctor');
      expect(result).toContain('===============');
      expect(result).toContain('Configuration');
      expect(result).toContain('✓');
      expect(result).toContain('Config File');
      expect(result).toContain('Env File');
    });

    it('should output text with correct summary line', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });

      expect(result).toContain('Result:');
      expect(result).toContain('2 passed');
      expect(result).toContain('0 failed');
      expect(result).toContain('0 warnings');
      expect(result).toContain('0 skipped');
    });
  });

  // ---------------------------------------------------------------------------
  // Missing config
  // ---------------------------------------------------------------------------

  describe('missing config', () => {
    it('should return exit code 1 when config file is missing', () => {
      const { status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      expect(status).toBe(1);
    });

    it('should report config fail and env-file skip in JSON', () => {
      const { stdout } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(report.exitCode).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.skipped).toBe(1);

      const configEntry = report.checks.find((c: any) => c.id === 'config');
      expect(configEntry.status).toBe('fail');
      expect(configEntry.message).toContain('Config file not found');
      expect(configEntry.suggestion).toBeDefined();

      const envEntry = report.checks.find((c: any) => c.id === 'env-file');
      expect(envEntry.status).toBe('skip');
      expect(envEntry.message).toContain("dependency 'config' failed");
    });

    it('should show fail symbol and suggestion in text output', () => {
      const { stdout } = runDoctorRaw(skipExternalFlags(), { cwd: testDir });

      expect(stdout).toContain('✗');
      expect(stdout).toContain('Config file not found');
      expect(stdout).toContain('→');
      // Skip symbol for env-file
      expect(stdout).toContain('-');
      expect(stdout).toContain("dependency 'config' failed");
    });

    it('should show correct failure summary counts in text', () => {
      const { stdout } = runDoctorRaw(skipExternalFlags(), { cwd: testDir });

      expect(stdout).toContain('1 failed');
      expect(stdout).toContain('1 skipped');
    });
  });

  // ---------------------------------------------------------------------------
  // Missing env file
  // ---------------------------------------------------------------------------

  describe('missing env file', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      // No generacy.env file
    });

    it('should pass config but fail env-file', () => {
      const { stdout, status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(status).toBe(1);
      expect(report.exitCode).toBe(1);

      const configEntry = report.checks.find((c: any) => c.id === 'config');
      expect(configEntry.status).toBe('pass');

      const envEntry = report.checks.find((c: any) => c.id === 'env-file');
      expect(envEntry.status).toBe('fail');
      expect(envEntry.message).toContain('Env file not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Env file with missing required keys
  // ---------------------------------------------------------------------------

  describe('env file with missing keys', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\n`,
      );
    });

    it('should fail env-file when ANTHROPIC_API_KEY is missing', () => {
      const { stdout, status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(status).toBe(1);
      const envEntry = report.checks.find((c: any) => c.id === 'env-file');
      expect(envEntry.status).toBe('fail');
      expect(envEntry.message).toContain('missing required keys');
      expect(envEntry.message).toContain('ANTHROPIC_API_KEY');
    });
  });

  // ---------------------------------------------------------------------------
  // Env file with empty values
  // ---------------------------------------------------------------------------

  describe('env file with empty values', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=\nANTHROPIC_API_KEY=\n`,
      );
    });

    it('should warn when env keys are present but empty', () => {
      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);

      // Warn status means exit code 0 (only fail causes exit 1)
      expect(report.exitCode).toBe(0);
      const envEntry = report.checks.find((c: any) => c.id === 'env-file');
      expect(envEntry.status).toBe('warn');
      expect(envEntry.message).toContain('empty values');
    });
  });

  // ---------------------------------------------------------------------------
  // --json flag
  // ---------------------------------------------------------------------------

  describe('--json output', () => {
    it('should produce valid JSON matching DoctorReport structure', () => {
      const { stdout } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      // Top-level structure
      expect(report).toHaveProperty('version', 1);
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('checks');
      expect(report).toHaveProperty('exitCode');

      // Summary structure
      expect(report.summary).toHaveProperty('passed');
      expect(report.summary).toHaveProperty('failed');
      expect(report.summary).toHaveProperty('warnings');
      expect(report.summary).toHaveProperty('skipped');
      expect(report.summary).toHaveProperty('total');

      // Checks array structure
      expect(Array.isArray(report.checks)).toBe(true);
      for (const check of report.checks) {
        expect(check).toHaveProperty('id');
        expect(check).toHaveProperty('label');
        expect(check).toHaveProperty('category');
        expect(check).toHaveProperty('status');
        expect(check).toHaveProperty('message');
        expect(['pass', 'fail', 'warn', 'skip']).toContain(check.status);
      }
    });

    it('should have a valid ISO timestamp', () => {
      const { stdout } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      const date = new Date(report.timestamp);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should have summary total matching checks array length', () => {
      const { stdout } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(report.summary.total).toBe(report.checks.length);
    });
  });

  // ---------------------------------------------------------------------------
  // --check flag
  // ---------------------------------------------------------------------------

  describe('--check flag', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
    });

    it('should run only the specified check', () => {
      const result = runDoctor('--check config --json', { cwd: testDir });
      const report = JSON.parse(result);

      expect(report.checks).toHaveLength(1);
      expect(report.checks[0].id).toBe('config');
      expect(report.checks[0].status).toBe('pass');
    });

    it('should auto-include transitive dependencies', () => {
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );

      const result = runDoctor('--check env-file --json', { cwd: testDir });
      const report = JSON.parse(result);

      // env-file depends on config, so both should be included
      expect(report.checks).toHaveLength(2);
      const ids = report.checks.map((c: any) => c.id);
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');

      // config should come before env-file (topological order)
      expect(ids.indexOf('config')).toBeLessThan(ids.indexOf('env-file'));
    });

    it('should exit 2 for unknown check names', () => {
      const { status, stderr } = runDoctorRaw('--check nonexistent', {
        cwd: testDir,
      });

      expect(status).toBe(2);
      expect(stderr).toContain('Unknown check');
      expect(stderr).toContain('nonexistent');
    });
  });

  // ---------------------------------------------------------------------------
  // --skip flag
  // ---------------------------------------------------------------------------

  describe('--skip flag', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );
    });

    it('should exclude skipped checks from results', () => {
      const result = runDoctor(
        '--skip docker devcontainer github-token anthropic-key npm-packages agency-mcp env-file --json',
        { cwd: testDir },
      );
      const report = JSON.parse(result);

      expect(report.checks).toHaveLength(1);
      expect(report.checks[0].id).toBe('config');
    });

    it('should exit 2 for unknown skip names', () => {
      const { status, stderr } = runDoctorRaw('--skip nonexistent', {
        cwd: testDir,
      });

      expect(status).toBe(2);
      expect(stderr).toContain('Unknown check');
      expect(stderr).toContain('nonexistent');
    });
  });

  // ---------------------------------------------------------------------------
  // --verbose flag
  // ---------------------------------------------------------------------------

  describe('--verbose flag', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );
    });

    it('should include detail lines when --verbose is passed', () => {
      const result = runDoctor(`${skipExternalFlags()} --verbose`, {
        cwd: testDir,
      });

      // Config check includes detail like "Project: Test Project (proj_test123)"
      expect(result).toContain('Project: Test Project (proj_test123)');
    });

    it('should not include detail lines without --verbose', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });

      // Detail should not appear in non-verbose output
      expect(result).not.toContain('Project: Test Project (proj_test123)');
    });
  });

  // ---------------------------------------------------------------------------
  // --fix flag (not yet implemented)
  // ---------------------------------------------------------------------------

  describe('--fix flag', () => {
    it('should print "not yet implemented" note to stderr', () => {
      const { stderr } = runDoctorRaw(
        `${skipExternalFlags()} --fix`,
        { cwd: testDir },
      );

      expect(stderr).toContain('not yet implemented');
    });
  });

  // ---------------------------------------------------------------------------
  // Text output format
  // ---------------------------------------------------------------------------

  describe('text output format', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );
    });

    it('should have a header', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });

      expect(result).toContain('Generacy Doctor');
      expect(result).toContain('===============');
    });

    it('should group checks under category headers', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });

      expect(result).toContain('Configuration');
    });

    it('should show Result summary at the end', () => {
      const result = runDoctor(skipExternalFlags(), { cwd: testDir });
      const lines = result.split('\n');
      const resultLine = lines.find((l) => l.startsWith('Result:'));

      expect(resultLine).toBeDefined();
      expect(resultLine).toMatch(/\d+ passed/);
      expect(resultLine).toMatch(/\d+ failed/);
      expect(resultLine).toMatch(/\d+ warnings/);
      expect(resultLine).toMatch(/\d+ skipped/);
    });
  });

  // ---------------------------------------------------------------------------
  // Devcontainer check integration
  // ---------------------------------------------------------------------------

  describe('devcontainer check', () => {
    beforeEach(() => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
    });

    it('should fail when .devcontainer is missing', () => {
      const { stdout } = runDoctorRaw('--check config devcontainer --json', {
        cwd: testDir,
      });
      const report = JSON.parse(stdout);
      const devEntry = report.checks.find(
        (c: any) => c.id === 'devcontainer',
      );

      expect(devEntry.status).toBe('fail');
      expect(devEntry.message).toContain('devcontainer.json not found');
    });

    it('should warn when devcontainer exists but missing Generacy feature', () => {
      mkdirSync(join(testDir, '.devcontainer'), { recursive: true });
      writeFileSync(
        join(testDir, '.devcontainer', 'devcontainer.json'),
        JSON.stringify({ name: 'test' }),
      );

      const result = runDoctor('--check config devcontainer --json', {
        cwd: testDir,
      });
      const report = JSON.parse(result);
      const devEntry = report.checks.find(
        (c: any) => c.id === 'devcontainer',
      );

      expect(devEntry.status).toBe('warn');
      expect(devEntry.message).toContain('missing Generacy feature');
    });

    it('should pass when devcontainer has Generacy feature', () => {
      mkdirSync(join(testDir, '.devcontainer'), { recursive: true });
      writeFileSync(
        join(testDir, '.devcontainer', 'devcontainer.json'),
        JSON.stringify({
          name: 'test',
          features: {
            'ghcr.io/generacy-ai/generacy/generacy:latest': {},
          },
        }),
      );

      const result = runDoctor('--check config devcontainer --json', {
        cwd: testDir,
      });
      const report = JSON.parse(result);
      const devEntry = report.checks.find(
        (c: any) => c.id === 'devcontainer',
      );

      expect(devEntry.status).toBe('pass');
      expect(devEntry.message).toContain('Generacy feature');
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid config YAML
  // ---------------------------------------------------------------------------

  describe('invalid config', () => {
    it('should fail with parse error for invalid YAML', () => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test"
  invalid: [unclosed
`,
      );

      const { stdout, status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(status).toBe(1);
      const configEntry = report.checks.find((c: any) => c.id === 'config');
      expect(configEntry.status).toBe('fail');
      expect(configEntry.message).toContain('invalid YAML syntax');
    });

    it('should fail with schema error for invalid project ID', () => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "invalid"
  name: "Test"

repos:
  primary: "github.com/test/repo"
`,
      );

      const { stdout, status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );
      const report = JSON.parse(stdout);

      expect(status).toBe(1);
      const configEntry = report.checks.find((c: any) => c.id === 'config');
      expect(configEntry.status).toBe('fail');
      expect(configEntry.message).toContain('schema validation');
    });
  });

  // ---------------------------------------------------------------------------
  // Exit codes
  // ---------------------------------------------------------------------------

  describe('exit codes', () => {
    it('should exit 0 when all checks pass', () => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=ghp_test123\nANTHROPIC_API_KEY=sk-ant-test123\n`,
      );

      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);

      expect(report.exitCode).toBe(0);
    });

    it('should exit 0 when checks only have warnings', () => {
      mkdirSync(join(testDir, '.generacy'), { recursive: true });
      writeFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        `
project:
  id: "proj_test123"
  name: "Test Project"

repos:
  primary: "github.com/test/repo"
`,
      );
      writeFileSync(
        join(testDir, '.generacy', 'generacy.env'),
        `GITHUB_TOKEN=\nANTHROPIC_API_KEY=\n`,
      );

      const result = runDoctor(`${skipExternalFlags()} --json`, {
        cwd: testDir,
      });
      const report = JSON.parse(result);

      // warn → exit 0, not 1
      expect(report.exitCode).toBe(0);
    });

    it('should exit 1 when any check fails', () => {
      const { status } = runDoctorRaw(
        `${skipExternalFlags()} --json`,
        { cwd: testDir },
      );

      expect(status).toBe(1);
    });

    it('should exit 2 for internal errors (unknown check name)', () => {
      const { status } = runDoctorRaw('--check bogus', { cwd: testDir });

      expect(status).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // JSON error output
  // ---------------------------------------------------------------------------

  describe('--json error output', () => {
    it('should output JSON error for unknown check name', () => {
      const { stdout, status } = runDoctorRaw('--check bogus --json', {
        cwd: testDir,
      });

      expect(status).toBe(2);
      const json = JSON.parse(stdout);
      expect(json.error).toContain('Unknown check');
      expect(json.exitCode).toBe(2);
    });
  });
});

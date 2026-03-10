/**
 * Integration tests for the `generacy init` CLI command.
 *
 * These tests run the CLI as a subprocess via `execSync`, following the same
 * pattern used by `validate.test.ts` and `doctor.test.ts`. Each test scenario
 * creates a fresh temp directory, optionally initialises a git repo, and
 * invokes the `generacy init` binary with the appropriate flags.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const cliPath = join(__dirname, '../../../bin/generacy.js');

/**
 * Run `generacy init` as a subprocess, returning stdout on success.
 * Throws on non-zero exit code (use `runInitRaw` for expected failures).
 */
function runInit(
  args: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  return execSync(`node ${cliPath} init ${args}`, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', ...opts.env },
  });
}

/**
 * Run `generacy init` capturing stdout, stderr, and exit status —
 * never throws, even on non-zero exit codes.
 */
function runInitRaw(
  args: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${cliPath} init ${args}`, {
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

/**
 * Initialise a bare git repo in the given directory so that the init command
 * recognises it as a valid git root.
 */
function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
}

describe('init CLI command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'generacy-init-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Non-interactive single-repo
  // ---------------------------------------------------------------------------

  describe('non-interactive single-repo', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should create all expected files', () => {
      runInit(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      // Expected single-repo files
      expect(existsSync(join(testDir, '.generacy', 'config.yaml'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', 'generacy.env.template'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', '.gitignore'))).toBe(true);
      expect(existsSync(join(testDir, '.vscode', 'extensions.json'))).toBe(true);
      expect(existsSync(join(testDir, '.devcontainer', 'devcontainer.json'))).toBe(true);

      // Standard cluster always generates docker-compose.yml
      expect(existsSync(join(testDir, '.devcontainer', 'docker-compose.yml'))).toBe(true);
    });

    it('should generate config.yaml with correct project name and repo', () => {
      runInit(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      const config = readFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        'utf-8',
      );
      expect(config).toContain('name: Test Project');
      expect(config).toContain('acme/app');
    });

    it('should generate a local placeholder project ID', () => {
      runInit(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      const config = readFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        'utf-8',
      );
      expect(config).toMatch(/id: proj_local[a-f0-9]{8}/);
    });

    it('should print a summary listing all created files', () => {
      const output = runInit(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(output).toContain('Created');
      expect(output).toContain('.generacy/config.yaml');
      expect(output).toContain('.generacy/generacy.env.template');
      expect(output).toContain('.generacy/.gitignore');
      expect(output).toContain('.vscode/extensions.json');
      expect(output).toContain('.devcontainer/devcontainer.json');
      expect(output).toContain('Done!');
    });

    it('should print next steps guidance', () => {
      const output = runInit(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(output).toContain('Next steps');
      expect(output).toContain('generacy doctor');
    });

    it('should exit with code 0', () => {
      const { status } = runInitRaw(
        '--project-name "Test Project" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(status).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Non-interactive multi-repo
  // ---------------------------------------------------------------------------

  describe('non-interactive multi-repo', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should create docker-compose.yml for multi-repo projects', () => {
      runInit(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.devcontainer', 'docker-compose.yml'))).toBe(true);
    });

    it('should create all standard files plus docker-compose.yml', () => {
      runInit(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy', 'config.yaml'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', 'generacy.env.template'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', '.gitignore'))).toBe(true);
      expect(existsSync(join(testDir, '.vscode', 'extensions.json'))).toBe(true);
      expect(existsSync(join(testDir, '.devcontainer', 'devcontainer.json'))).toBe(true);
      expect(existsSync(join(testDir, '.devcontainer', 'docker-compose.yml'))).toBe(true);
    });

    it('should include dev repo in the generated config', () => {
      runInit(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      const config = readFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        'utf-8',
      );
      expect(config).toContain('acme/lib');
    });

    it('should generate a valid docker-compose.yml with services', () => {
      runInit(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      const compose = readFileSync(
        join(testDir, '.devcontainer', 'docker-compose.yml'),
        'utf-8',
      );
      expect(compose).toContain('services:');
    });

    it('should print summary with docker-compose.yml and created count', () => {
      const output = runInit(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(output).toContain('.devcontainer/docker-compose.yml');
      expect(output).toContain('created');
    });

    it('should exit with code 0', () => {
      const { status } = runInitRaw(
        '--project-name "Multi" --primary-repo "acme/app" --dev-repo "acme/lib" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(status).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Not in a git repo
  // ---------------------------------------------------------------------------

  describe('not in a git repo', () => {
    it('should exit with code 1', () => {
      const { status } = runInitRaw(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(status).toBe(1);
    });

    it('should print error about not being in a git repository', () => {
      const { stdout } = runInitRaw(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(stdout).toContain('Not inside a Git repository');
    });

    it('should not create any files', () => {
      runInitRaw(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy'))).toBe(false);
      expect(existsSync(join(testDir, '.devcontainer'))).toBe(false);
      expect(existsSync(join(testDir, '.vscode'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Dry-run mode
  // ---------------------------------------------------------------------------

  describe('dry-run mode', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should not write any files to disk', () => {
      runInit(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check --dry-run',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy'))).toBe(false);
      expect(existsSync(join(testDir, '.devcontainer'))).toBe(false);
      expect(existsSync(join(testDir, '.vscode'))).toBe(false);
    });

    it('should show preview with "Would create" prefix', () => {
      const output = runInit(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check --dry-run',
        { cwd: testDir },
      );

      expect(output).toContain('Would create');
      expect(output).toContain('.generacy/config.yaml');
    });

    it('should indicate dry-run in the summary', () => {
      const output = runInit(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check --dry-run',
        { cwd: testDir },
      );

      expect(output).toContain('Dry run');
      expect(output).toContain('no files were written');
    });

    it('should not print next steps in dry-run mode', () => {
      const output = runInit(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check --dry-run',
        { cwd: testDir },
      );

      expect(output).not.toContain('Next steps');
    });

    it('should exit with code 0', () => {
      const { status } = runInitRaw(
        '--project-name "Test" --primary-repo "acme/app" -y --skip-github-check --dry-run',
        { cwd: testDir },
      );

      expect(status).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Force overwrite
  // ---------------------------------------------------------------------------

  describe('force overwrite', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should succeed on second run with --force', () => {
      // First init
      runInit(
        '--project-name "First" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      // Second init with --force to overwrite
      const { status } = runInitRaw(
        '--project-name "Second" --primary-repo "acme/app" -y --skip-github-check --force',
        { cwd: testDir },
      );

      expect(status).toBe(0);
    });

    it('should update file content on forced re-init', () => {
      // First init
      runInit(
        '--project-name "First" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      const configBefore = readFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        'utf-8',
      );
      expect(configBefore).toContain('name: First');

      // Second init with different project name
      runInit(
        '--project-name "Second" --primary-repo "acme/app" -y --skip-github-check --force',
        { cwd: testDir },
      );

      const configAfter = readFileSync(
        join(testDir, '.generacy', 'config.yaml'),
        'utf-8',
      );
      expect(configAfter).toContain('name: Second');
      expect(configAfter).not.toContain('name: First');
    });

    it('should show "Overwritten" in the summary for the second run', () => {
      // First init
      runInit(
        '--project-name "First" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      // Second init with --force
      const output = runInit(
        '--project-name "Second" --primary-repo "acme/app" -y --skip-github-check --force',
        { cwd: testDir },
      );

      expect(output).toContain('Overwritten');
    });

    it('should preserve all expected files after forced re-init', () => {
      // First init
      runInit(
        '--project-name "First" --primary-repo "acme/app" -y --skip-github-check',
        { cwd: testDir },
      );

      // Second init with --force
      runInit(
        '--project-name "Second" --primary-repo "acme/app" -y --skip-github-check --force',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy', 'config.yaml'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', 'generacy.env.template'))).toBe(true);
      expect(existsSync(join(testDir, '.generacy', '.gitignore'))).toBe(true);
      expect(existsSync(join(testDir, '.vscode', 'extensions.json'))).toBe(true);
      expect(existsSync(join(testDir, '.devcontainer', 'devcontainer.json'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Invalid repo format
  // ---------------------------------------------------------------------------

  describe('invalid repo format', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should exit with code 1 for invalid primary repo', () => {
      const { status } = runInitRaw(
        '--project-name "Test" --primary-repo "not-valid" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(status).toBe(1);
    });

    it('should print an error message about invalid repo format', () => {
      const { stdout } = runInitRaw(
        '--project-name "Test" --primary-repo "not-valid" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(stdout).toContain('not-valid');
      expect(stdout).toMatch(/[Uu]nrecognized|[Ii]nvalid/);
    });

    it('should not create any files', () => {
      runInitRaw(
        '--project-name "Test" --primary-repo "not-valid" -y --skip-github-check',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Missing required in non-interactive mode
  // ---------------------------------------------------------------------------

  describe('missing required in non-interactive mode', () => {
    beforeEach(() => {
      gitInit(testDir);
    });

    it('should exit with code 1 when --yes is used without primary repo and no remote', () => {
      const { status } = runInitRaw(
        '-y --skip-github-check',
        { cwd: testDir },
      );

      expect(status).toBe(1);
    });

    it('should print an error about missing primary repo', () => {
      const { stdout } = runInitRaw(
        '-y --skip-github-check',
        { cwd: testDir },
      );

      expect(stdout).toMatch(/[Cc]annot auto-detect|primary.repo|--primary-repo/);
    });

    it('should not create any files', () => {
      runInitRaw(
        '-y --skip-github-check',
        { cwd: testDir },
      );

      expect(existsSync(join(testDir, '.generacy'))).toBe(false);
    });
  });
});

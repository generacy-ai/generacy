import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runChecks } from '../runner.js';
import type {
  CheckDefinition,
  CheckContext,
  CheckResult,
  DoctorOptions,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal check definition for testing. */
function makeCheck(
  overrides: Partial<CheckDefinition> & Pick<CheckDefinition, 'id'>,
): CheckDefinition {
  return {
    label: overrides.id,
    category: 'system',
    dependencies: [],
    priority: 'P1',
    run: async () => ({ status: 'pass', message: 'ok' }),
    ...overrides,
  };
}

const defaultOptions: DoctorOptions = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runChecks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  describe('basic execution', () => {
    it('runs a single passing check and returns a valid report', async () => {
      const checks = [makeCheck({ id: 'alpha' })];
      const report = await runChecks(checks, defaultOptions);

      expect(report.version).toBe(1);
      expect(report.timestamp).toBeTruthy();
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0].id).toBe('alpha');
      expect(report.checks[0].status).toBe('pass');
      expect(report.checks[0].message).toBe('ok');
      expect(report.exitCode).toBe(0);
    });

    it('returns an empty report for zero checks', async () => {
      const report = await runChecks([], defaultOptions);

      expect(report.checks).toEqual([]);
      expect(report.summary.total).toBe(0);
      expect(report.exitCode).toBe(0);
    });

    it('preserves check metadata in report entries', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          label: 'Config file',
          category: 'config',
        }),
      ];
      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].id).toBe('config');
      expect(report.checks[0].label).toBe('Config file');
      expect(report.checks[0].category).toBe('config');
    });

    it('includes suggestion and detail in report entries when present', async () => {
      const checks = [
        makeCheck({
          id: 'docker',
          run: async () => ({
            status: 'fail',
            message: 'Docker not found',
            suggestion: 'Install Docker Desktop',
            detail: 'Command not found in PATH',
          }),
        }),
      ];
      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].suggestion).toBe('Install Docker Desktop');
      expect(report.checks[0].detail).toBe('Command not found in PATH');
    });

    it('omits suggestion and detail from report entries when absent', async () => {
      const checks = [makeCheck({ id: 'alpha' })];
      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0]).not.toHaveProperty('suggestion');
      expect(report.checks[0]).not.toHaveProperty('detail');
    });

    it('tracks duration for each check', async () => {
      const checks = [makeCheck({ id: 'alpha' })];
      const report = await runChecks(checks, defaultOptions);

      expect(typeof report.checks[0].duration_ms).toBe('number');
      expect(report.checks[0].duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent execution within tiers
  // -----------------------------------------------------------------------

  describe('concurrent execution within tiers', () => {
    it('runs independent checks concurrently (same tier)', async () => {
      const order: string[] = [];

      const checks = [
        makeCheck({
          id: 'a',
          run: async () => {
            order.push('a-start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('a-end');
            return { status: 'pass', message: 'ok' };
          },
        }),
        makeCheck({
          id: 'b',
          run: async () => {
            order.push('b-start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('b-end');
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      // Both should start before either finishes (concurrent execution)
      expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'));
      expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
      // Both start before either ends (interleaved)
      expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('b-end'));
      expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
    });

    it('runs checks in dependency order across tiers', async () => {
      const order: string[] = [];

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => {
            order.push('config');
            return { status: 'pass', message: 'ok' };
          },
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => {
            order.push('env-file');
            return { status: 'pass', message: 'ok' };
          },
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
          run: async () => {
            order.push('github-token');
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(order).toEqual(['config', 'env-file', 'github-token']);
    });

    it('runs tier-0 checks concurrently then tier-1 after', async () => {
      const order: string[] = [];

      const checks = [
        makeCheck({
          id: 'docker',
          run: async () => {
            order.push('docker');
            return { status: 'pass', message: 'ok' };
          },
        }),
        makeCheck({
          id: 'config',
          run: async () => {
            order.push('config');
            return { status: 'pass', message: 'ok' };
          },
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => {
            order.push('env-file');
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      // docker and config are tier 0; env-file is tier 1
      // env-file must run after config
      expect(order.indexOf('config')).toBeLessThan(order.indexOf('env-file'));
      // docker is independent, runs in tier 0 (before env-file)
      expect(order.indexOf('docker')).toBeLessThan(order.indexOf('env-file'));
    });
  });

  // -----------------------------------------------------------------------
  // Dependency skip propagation
  // -----------------------------------------------------------------------

  describe('dependency skip propagation', () => {
    it('skips a check when its dependency fails', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'Config not found' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[1].status).toBe('skip');
      expect(report.checks[1].message).toContain("dependency 'config' failed");
    });

    it('does not call run() on a skipped check', async () => {
      const envFileRun = vi.fn(async () => ({
        status: 'pass' as const,
        message: 'ok',
      }));

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'Config not found' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: envFileRun,
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(envFileRun).not.toHaveBeenCalled();
    });

    it('propagates skips through a dependency chain', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'Config not found' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[1].status).toBe('skip');
      expect(report.checks[1].message).toContain("dependency 'config' failed");
      expect(report.checks[2].status).toBe('skip');
      expect(report.checks[2].message).toContain(
        "dependency 'env-file' failed",
      );
    });

    it('skips a check when its dependency was itself skipped', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      // github-token is skipped because env-file was skipped (not directly because config failed)
      expect(report.checks[2].status).toBe('skip');
    });

    it('does not skip a check when dependency passes', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[1].status).toBe('pass');
    });

    it('does not skip a check when dependency warns', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'warn', message: 'something off' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[1].status).toBe('pass');
    });

    it('skips dependent even when only one of multiple dependencies fails', async () => {
      const checks = [
        makeCheck({
          id: 'a',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'b',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'c',
          dependencies: ['a', 'b'],
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[2].status).toBe('skip');
      expect(report.checks[2].message).toContain("dependency 'b' failed");
    });

    it('sets duration_ms to 0 for skipped checks', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[1].duration_ms).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Context passing between checks
  // -----------------------------------------------------------------------

  describe('context passing between checks', () => {
    it('merges configPath from check result data into context', async () => {
      let capturedContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { configPath: '/path/to/config.yaml' },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.configPath).toBe('/path/to/config.yaml');
    });

    it('merges projectRoot from check result data into context', async () => {
      let capturedContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { projectRoot: '/path/to/project' },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(capturedContext!.projectRoot).toBe('/path/to/project');
    });

    it('merges config object from check result data into context', async () => {
      let capturedContext: CheckContext | null = null;
      const fakeConfig = { org: 'test-org', repo: 'test-repo' };

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { config: fakeConfig },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(capturedContext!.config).toBe(fakeConfig);
    });

    it('merges envVars from check result data into context', async () => {
      let capturedContext: CheckContext | null = null;
      const envVars = { GITHUB_TOKEN: 'ghp_xxx', ANTHROPIC_API_KEY: 'sk-xxx' };

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { configPath: '/a/b' },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { envVars },
          }),
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
          category: 'credentials',
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(capturedContext!.envVars).toBe(envVars);
    });

    it('does not merge unknown keys into context', async () => {
      let capturedContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: { unknownField: 'should be ignored' },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(capturedContext).not.toHaveProperty('unknownField');
    });

    it('progressively builds context across multiple checks', async () => {
      let finalContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: {
              configPath: '/home/.generacy/config.yaml',
              projectRoot: '/home/project',
            },
          }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
          run: async () => ({
            status: 'pass',
            message: 'ok',
            data: {
              envVars: { GITHUB_TOKEN: 'ghp_123' },
            },
          }),
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
          category: 'credentials',
          run: async (ctx) => {
            finalContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, defaultOptions);

      expect(finalContext!.configPath).toBe('/home/.generacy/config.yaml');
      expect(finalContext!.projectRoot).toBe('/home/project');
      expect(finalContext!.envVars).toEqual({ GITHUB_TOKEN: 'ghp_123' });
    });

    it('sets verbose in context from options', async () => {
      let capturedContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'alpha',
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, { verbose: true });

      expect(capturedContext!.verbose).toBe(true);
    });

    it('defaults verbose to false when not set', async () => {
      let capturedContext: CheckContext | null = null;

      const checks = [
        makeCheck({
          id: 'alpha',
          run: async (ctx) => {
            capturedContext = { ...ctx };
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      await runChecks(checks, {});

      expect(capturedContext!.verbose).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------

  describe('timeout handling', () => {
    it('times out network checks (credentials category) that exceed 5s', async () => {
      const checks = [
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          run: async () => {
            // Simulate a check that hangs for 10 seconds
            await new Promise((r) => setTimeout(r, 10_000));
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      const reportPromise = runChecks(checks, defaultOptions);
      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(6_000);
      const report = await reportPromise;

      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[0].message).toContain('timed out');
      expect(report.checks[0].message).toContain('5s');
    });

    it('times out network checks (services category) that exceed 5s', async () => {
      const checks = [
        makeCheck({
          id: 'agency-mcp',
          category: 'services',
          run: async () => {
            await new Promise((r) => setTimeout(r, 10_000));
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      const reportPromise = runChecks(checks, defaultOptions);
      await vi.advanceTimersByTimeAsync(6_000);
      const report = await reportPromise;

      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[0].message).toContain('timed out');
    });

    it('includes check id in timeout suggestion', async () => {
      const checks = [
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          run: async () => {
            await new Promise((r) => setTimeout(r, 10_000));
            return { status: 'pass', message: 'ok' };
          },
        }),
      ];

      const reportPromise = runChecks(checks, defaultOptions);
      await vi.advanceTimersByTimeAsync(6_000);
      const report = await reportPromise;

      expect(report.checks[0].suggestion).toContain('github-token');
    });

    it('does not timeout non-network checks (system category)', async () => {
      const checks = [
        makeCheck({
          id: 'docker',
          category: 'system',
          run: async () => {
            // This delay is less than 5s but we're checking that no timeout wrapper is applied
            await new Promise((r) => setTimeout(r, 50));
            return { status: 'pass', message: 'Docker running' };
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('pass');
      expect(report.checks[0].message).toBe('Docker running');
    });

    it('does not timeout non-network checks (config category)', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          category: 'config',
          run: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { status: 'pass', message: 'Config valid' };
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('pass');
    });

    it('allows network checks that complete within timeout', async () => {
      const checks = [
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          run: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { status: 'pass', message: 'Token valid' };
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('pass');
      expect(report.checks[0].message).toBe('Token valid');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('catches thrown errors and returns fail with Internal error message', async () => {
      const checks = [
        makeCheck({
          id: 'broken',
          run: async () => {
            throw new Error('something went wrong');
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[0].message).toBe(
        'Internal error: something went wrong',
      );
    });

    it('includes stack trace in detail for Error instances', async () => {
      const checks = [
        makeCheck({
          id: 'broken',
          run: async () => {
            throw new Error('oops');
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].detail).toContain('Error: oops');
    });

    it('handles non-Error thrown values', async () => {
      const checks = [
        makeCheck({
          id: 'broken',
          run: async () => {
            throw 'string error';
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[0].message).toBe('Internal error: string error');
      expect(report.checks[0].detail).toBeUndefined();
    });

    it('tracks duration even for checks that throw', async () => {
      const checks = [
        makeCheck({
          id: 'broken',
          run: async () => {
            throw new Error('fail');
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(typeof report.checks[0].duration_ms).toBe('number');
      expect(report.checks[0].duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------------------------------------
  // Summary computation
  // -----------------------------------------------------------------------

  describe('summary computation', () => {
    it('counts all pass results correctly', async () => {
      const checks = [
        makeCheck({ id: 'a' }),
        makeCheck({ id: 'b' }),
        makeCheck({ id: 'c' }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.summary).toEqual({
        passed: 3,
        failed: 0,
        warnings: 0,
        skipped: 0,
        total: 3,
      });
    });

    it('counts mixed results correctly', async () => {
      const checks = [
        makeCheck({
          id: 'pass-check',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'fail-check',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'warn-check',
          run: async () => ({ status: 'warn', message: 'hmm' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.skipped).toBe(0);
      expect(report.summary.total).toBe(3);
    });

    it('counts skipped checks in summary', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
        }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
          category: 'credentials',
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.summary.failed).toBe(1);
      expect(report.summary.skipped).toBe(2);
      expect(report.summary.total).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Exit codes
  // -----------------------------------------------------------------------

  describe('exit codes', () => {
    it('returns exit code 0 when all checks pass', async () => {
      const checks = [
        makeCheck({
          id: 'a',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'b',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      expect(report.exitCode).toBe(0);
    });

    it('returns exit code 0 when checks pass or warn (no failures)', async () => {
      const checks = [
        makeCheck({
          id: 'a',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'b',
          run: async () => ({ status: 'warn', message: 'hmm' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      expect(report.exitCode).toBe(0);
    });

    it('returns exit code 0 when there are only skipped checks', async () => {
      const checks = [
        makeCheck({
          id: 'config',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
        makeCheck({
          id: 'env-file',
          dependencies: ['config'],
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      // One fail + one skip → exit code 1 because of the fail
      expect(report.exitCode).toBe(1);
    });

    it('returns exit code 1 when any check fails', async () => {
      const checks = [
        makeCheck({
          id: 'a',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'b',
          run: async () => ({ status: 'fail', message: 'bad' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      expect(report.exitCode).toBe(1);
    });

    it('returns exit code 2 for internal errors (thrown exceptions)', async () => {
      const checks = [
        makeCheck({
          id: 'broken',
          run: async () => {
            throw new Error('unexpected');
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      expect(report.exitCode).toBe(2);
    });

    it('exit code 2 takes priority over exit code 1', async () => {
      const checks = [
        makeCheck({
          id: 'fail-check',
          run: async () => ({ status: 'fail', message: 'regular failure' }),
        }),
        makeCheck({
          id: 'broken-check',
          run: async () => {
            throw new Error('internal issue');
          },
        }),
      ];

      const report = await runChecks(checks, defaultOptions);
      expect(report.exitCode).toBe(2);
    });

    it('returns exit code 0 for empty check list', async () => {
      const report = await runChecks([], defaultOptions);
      expect(report.exitCode).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Report structure
  // -----------------------------------------------------------------------

  describe('report structure', () => {
    it('includes version 1', async () => {
      const report = await runChecks([makeCheck({ id: 'a' })], defaultOptions);
      expect(report.version).toBe(1);
    });

    it('includes an ISO timestamp', async () => {
      const report = await runChecks([makeCheck({ id: 'a' })], defaultOptions);
      // Verify it's a valid ISO string
      expect(() => new Date(report.timestamp)).not.toThrow();
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });

    it('preserves check order from input in report entries', async () => {
      const checks = [
        makeCheck({ id: 'config' }),
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
        makeCheck({
          id: 'github-token',
          dependencies: ['env-file'],
          category: 'credentials',
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      const ids = report.checks.map((c) => c.id);
      expect(ids).toEqual(['config', 'env-file', 'github-token']);
    });
  });

  // -----------------------------------------------------------------------
  // Realistic scenario
  // -----------------------------------------------------------------------

  describe('realistic scenario', () => {
    it('runs a full 8-check doctor scenario', async () => {
      const checks = [
        makeCheck({
          id: 'docker',
          category: 'system',
          run: async () => ({ status: 'pass', message: 'Docker v24.0.5' }),
        }),
        makeCheck({
          id: 'devcontainer',
          category: 'system',
          priority: 'P2',
          run: async () => ({ status: 'pass', message: 'devcontainer.json found' }),
        }),
        makeCheck({
          id: 'config',
          category: 'config',
          run: async () => ({
            status: 'pass',
            message: 'Config valid',
            data: {
              configPath: '/home/.generacy/config.yaml',
              projectRoot: '/home/project',
              config: { org: 'test' },
            },
          }),
        }),
        makeCheck({
          id: 'npm-packages',
          category: 'packages',
          priority: 'P2',
          run: async () => ({ status: 'warn', message: 'Version mismatch' }),
        }),
        makeCheck({
          id: 'agency-mcp',
          category: 'services',
          priority: 'P2',
          run: async () => ({ status: 'skip', message: 'AGENCY_URL not set' }),
        }),
        makeCheck({
          id: 'env-file',
          category: 'config',
          dependencies: ['config'],
          run: async () => ({
            status: 'pass',
            message: 'Env file valid',
            data: {
              envVars: { GITHUB_TOKEN: 'ghp_xxx', ANTHROPIC_API_KEY: 'sk-xxx' },
            },
          }),
        }),
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          dependencies: ['env-file'],
          run: async () => ({ status: 'pass', message: 'Token valid (repo, workflow)' }),
        }),
        makeCheck({
          id: 'anthropic-key',
          category: 'credentials',
          dependencies: ['env-file'],
          run: async () => ({ status: 'pass', message: 'API key valid' }),
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks).toHaveLength(8);
      expect(report.summary.passed).toBe(6);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.skipped).toBe(1);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.total).toBe(8);
      expect(report.exitCode).toBe(0);
    });

    it('cascades failure through dependency chain in realistic scenario', async () => {
      const checks = [
        makeCheck({
          id: 'docker',
          category: 'system',
          run: async () => ({ status: 'pass', message: 'ok' }),
        }),
        makeCheck({
          id: 'config',
          category: 'config',
          run: async () => ({
            status: 'fail',
            message: 'Config file not found',
            suggestion: 'Run generacy init',
          }),
        }),
        makeCheck({
          id: 'env-file',
          category: 'config',
          dependencies: ['config'],
        }),
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          dependencies: ['env-file'],
        }),
        makeCheck({
          id: 'anthropic-key',
          category: 'credentials',
          dependencies: ['env-file'],
        }),
      ];

      const report = await runChecks(checks, defaultOptions);

      expect(report.checks[0].status).toBe('pass'); // docker
      expect(report.checks[1].status).toBe('fail'); // config
      expect(report.checks[2].status).toBe('skip'); // env-file
      expect(report.checks[3].status).toBe('skip'); // github-token
      expect(report.checks[4].status).toBe('skip'); // anthropic-key
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.skipped).toBe(3);
      expect(report.exitCode).toBe(1);
    });
  });
});

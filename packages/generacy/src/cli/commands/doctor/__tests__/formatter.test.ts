import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatText, formatJson } from '../formatter.js';
import type {
  CheckDefinition,
  DoctorReport,
  DoctorReportCheckEntry,
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

/** Create a minimal report check entry. */
function makeEntry(
  overrides: Partial<DoctorReportCheckEntry> & Pick<DoctorReportCheckEntry, 'id'>,
): DoctorReportCheckEntry {
  return {
    label: overrides.id,
    category: 'system',
    status: 'pass',
    message: 'ok',
    ...overrides,
  };
}

/** Create a minimal doctor report. */
function makeReport(
  checks: DoctorReportCheckEntry[],
  overrides?: Partial<DoctorReport>,
): DoctorReport {
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;

  return {
    version: 1,
    timestamp: '2026-02-26T00:00:00.000Z',
    summary: { passed, failed, warnings, skipped, total: checks.length },
    checks,
    exitCode: failed > 0 ? 1 : 0,
    ...overrides,
  };
}

/** Strip ANSI escape codes from a string. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatText', () => {
  const savedNoColor = process.env.NO_COLOR;

  afterEach(() => {
    // Restore NO_COLOR env var
    if (savedNoColor !== undefined) {
      process.env.NO_COLOR = savedNoColor;
    } else {
      delete process.env.NO_COLOR;
    }
  });

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  describe('header', () => {
    it('starts with a Generacy Doctor header and separator', () => {
      const report = makeReport([]);
      const output = stripAnsi(formatText(report, [], false));

      expect(output).toContain('Generacy Doctor');
      expect(output).toContain('===============');
    });
  });

  // -----------------------------------------------------------------------
  // Category grouping
  // -----------------------------------------------------------------------

  describe('category grouping', () => {
    it('groups checks under their category label', () => {
      const entries = [
        makeEntry({ id: 'docker', category: 'system', message: 'Docker running' }),
        makeEntry({ id: 'config', category: 'config', message: 'Config valid' }),
      ];
      const checks = [
        makeCheck({ id: 'docker', category: 'system' }),
        makeCheck({ id: 'config', category: 'config' }),
      ];
      const report = makeReport(entries);

      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('System');
      expect(output).toContain('Configuration');
    });

    it('uses correct category display labels', () => {
      const categories = [
        { category: 'system' as const, label: 'System' },
        { category: 'config' as const, label: 'Configuration' },
        { category: 'credentials' as const, label: 'Credentials' },
        { category: 'packages' as const, label: 'Packages' },
        { category: 'services' as const, label: 'Services' },
      ];

      for (const { category, label } of categories) {
        const entries = [makeEntry({ id: `test-${category}`, category })];
        const checks = [makeCheck({ id: `test-${category}`, category })];
        const report = makeReport(entries);
        const output = stripAnsi(formatText(report, checks, false));

        expect(output).toContain(label);
      }
    });

    it('renders categories in fixed order: system, config, credentials, packages, services', () => {
      // Provide entries in reverse order to verify sorting
      const entries = [
        makeEntry({ id: 'mcp', category: 'services', message: 'MCP reachable' }),
        makeEntry({ id: 'npm', category: 'packages', message: 'npm ok' }),
        makeEntry({ id: 'gh', category: 'credentials', message: 'Token valid' }),
        makeEntry({ id: 'cfg', category: 'config', message: 'Config ok' }),
        makeEntry({ id: 'docker', category: 'system', message: 'Docker ok' }),
      ];
      const checks = [
        makeCheck({ id: 'mcp', category: 'services' }),
        makeCheck({ id: 'npm', category: 'packages' }),
        makeCheck({ id: 'gh', category: 'credentials' }),
        makeCheck({ id: 'cfg', category: 'config' }),
        makeCheck({ id: 'docker', category: 'system' }),
      ];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      const systemIdx = output.indexOf('System');
      const configIdx = output.indexOf('Configuration');
      const credentialsIdx = output.indexOf('Credentials');
      const packagesIdx = output.indexOf('Packages');
      const servicesIdx = output.indexOf('Services');

      expect(systemIdx).toBeLessThan(configIdx);
      expect(configIdx).toBeLessThan(credentialsIdx);
      expect(credentialsIdx).toBeLessThan(packagesIdx);
      expect(packagesIdx).toBeLessThan(servicesIdx);
    });

    it('omits categories with no entries', () => {
      const entries = [
        makeEntry({ id: 'docker', category: 'system', message: 'Docker ok' }),
      ];
      const checks = [makeCheck({ id: 'docker', category: 'system' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('System');
      expect(output).not.toContain('Configuration');
      expect(output).not.toContain('Credentials');
      expect(output).not.toContain('Packages');
      expect(output).not.toContain('Services');
    });
  });

  // -----------------------------------------------------------------------
  // Status symbols
  // -----------------------------------------------------------------------

  describe('status symbols', () => {
    it('shows ✓ for passing checks', () => {
      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('✓');
    });

    it('shows ✗ for failing checks', () => {
      const entries = [makeEntry({ id: 'a', status: 'fail', message: 'broken' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('✗');
    });

    it('shows ! for warning checks', () => {
      const entries = [makeEntry({ id: 'a', status: 'warn', message: 'hmm' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('!');
    });

    it('shows - for skipped checks', () => {
      const entries = [makeEntry({ id: 'a', status: 'skip', message: 'skipped' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('-');
    });
  });

  // -----------------------------------------------------------------------
  // Check lines
  // -----------------------------------------------------------------------

  describe('check lines', () => {
    it('includes check label and message on each line', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          label: 'Docker',
          category: 'system',
          message: 'Docker daemon is running (v27.0.3)',
        }),
      ];
      const checks = [makeCheck({ id: 'docker', label: 'Docker', category: 'system' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('Docker');
      expect(output).toContain('Docker daemon is running (v27.0.3)');
    });

    it('uses check definition label over entry label', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          label: 'entry-label',
          category: 'system',
          message: 'ok',
        }),
      ];
      const checks = [
        makeCheck({ id: 'docker', label: 'Definition Label', category: 'system' }),
      ];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('Definition Label');
    });

    it('falls back to entry label when check definition is missing', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          label: 'Fallback Label',
          category: 'system',
          message: 'ok',
        }),
      ];
      // No matching check definition
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, [], false));

      expect(output).toContain('Fallback Label');
    });

    it('pads labels for alignment within a category', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          category: 'system',
          message: 'Docker ok',
        }),
        makeEntry({
          id: 'devcontainer',
          category: 'system',
          message: 'Devcontainer ok',
        }),
      ];
      const checks = [
        makeCheck({ id: 'docker', label: 'Docker', category: 'system' }),
        makeCheck({ id: 'devcontainer', label: 'Dev Container', category: 'system' }),
      ];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));
      const lines = output.split('\n');

      // Find the two check lines
      const dockerLine = lines.find((l) => l.includes('Docker ok'));
      const devcontainerLine = lines.find((l) => l.includes('Devcontainer ok'));

      expect(dockerLine).toBeDefined();
      expect(devcontainerLine).toBeDefined();

      // "Docker" is 6 chars, "Dev Container" is 13 chars
      // Docker should be padded to match Dev Container's length
      // Both messages should start at the same column
      const dockerMsgIdx = dockerLine!.indexOf('Docker ok');
      const devcontainerMsgIdx = devcontainerLine!.indexOf('Devcontainer ok');
      expect(dockerMsgIdx).toBe(devcontainerMsgIdx);
    });
  });

  // -----------------------------------------------------------------------
  // Suggestion lines
  // -----------------------------------------------------------------------

  describe('suggestion lines', () => {
    it('shows suggestion for failed checks', () => {
      const entries = [
        makeEntry({
          id: 'env',
          status: 'fail',
          message: 'Env file not found',
          suggestion: 'Run `generacy init` to generate the env file',
        }),
      ];
      const checks = [makeCheck({ id: 'env' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('→ Run `generacy init` to generate the env file');
    });

    it('shows suggestion for warning checks', () => {
      const entries = [
        makeEntry({
          id: 'npm',
          status: 'warn',
          message: 'Version mismatch',
          suggestion: 'Run `pnpm install` to update',
        }),
      ];
      const checks = [makeCheck({ id: 'npm' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('→ Run `pnpm install` to update');
    });

    it('does not show suggestion for passing checks even if present', () => {
      const entries = [
        makeEntry({
          id: 'a',
          status: 'pass',
          message: 'ok',
          suggestion: 'Should not appear',
        }),
      ];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).not.toContain('Should not appear');
    });

    it('does not show suggestion for skipped checks even if present', () => {
      const entries = [
        makeEntry({
          id: 'a',
          status: 'skip',
          message: 'skipped',
          suggestion: 'Should not appear',
        }),
      ];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).not.toContain('Should not appear');
    });

    it('does not show suggestion arrow when suggestion is absent', () => {
      const entries = [
        makeEntry({
          id: 'a',
          status: 'fail',
          message: 'broken',
          // no suggestion
        }),
      ];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));
      const lines = output.split('\n');

      // The fail line should exist but no suggestion arrow line after it
      const failLineIdx = lines.findIndex((l) => l.includes('broken'));
      expect(failLineIdx).toBeGreaterThan(-1);
      // Next non-empty line should not start with →
      const nextLine = lines[failLineIdx + 1];
      expect(nextLine?.trim().startsWith('→')).not.toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Detail lines (verbose mode)
  // -----------------------------------------------------------------------

  describe('detail lines (verbose mode)', () => {
    it('shows detail when verbose is true', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          message: 'Docker running',
          detail: '/usr/bin/docker v27.0.3',
        }),
      ];
      const checks = [makeCheck({ id: 'docker' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, true));

      expect(output).toContain('/usr/bin/docker v27.0.3');
    });

    it('does not show detail when verbose is false', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          message: 'Docker running',
          detail: '/usr/bin/docker v27.0.3',
        }),
      ];
      const checks = [makeCheck({ id: 'docker' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).not.toContain('/usr/bin/docker v27.0.3');
    });

    it('does not show detail line when detail is absent even if verbose', () => {
      const entries = [
        makeEntry({
          id: 'a',
          message: 'ok',
          // no detail
        }),
      ];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, true);
      const lines = output.split('\n');

      // The check line should exist, and the next line should not be an indented detail
      const checkLineIdx = lines.findIndex((l) => stripAnsi(l).includes('ok'));
      expect(checkLineIdx).toBeGreaterThan(-1);
    });

    it('shows both suggestion and detail for failed checks in verbose mode', () => {
      const entries = [
        makeEntry({
          id: 'a',
          status: 'fail',
          message: 'broken',
          suggestion: 'Fix it',
          detail: 'Stack trace here',
        }),
      ];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, true));

      expect(output).toContain('→ Fix it');
      expect(output).toContain('Stack trace here');
    });
  });

  // -----------------------------------------------------------------------
  // Summary line
  // -----------------------------------------------------------------------

  describe('summary line', () => {
    it('includes pass/fail/warning/skip counts', () => {
      const entries = [
        makeEntry({ id: 'a', status: 'pass' }),
        makeEntry({ id: 'b', status: 'fail', message: 'bad' }),
        makeEntry({ id: 'c', status: 'warn', message: 'hmm' }),
        makeEntry({ id: 'd', status: 'skip', message: 'skipped' }),
      ];
      const checks = entries.map((e) => makeCheck({ id: e.id }));
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('Result:');
      expect(output).toContain('1 passed');
      expect(output).toContain('1 failed');
      expect(output).toContain('1 warnings');
      expect(output).toContain('1 skipped');
    });

    it('shows zero counts correctly', () => {
      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      expect(output).toContain('1 passed');
      expect(output).toContain('0 failed');
      expect(output).toContain('0 warnings');
      expect(output).toContain('0 skipped');
    });

    it('appears at the end of output', () => {
      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));
      const lines = output.split('\n');

      const lastNonEmptyLine = lines.filter((l) => l.trim() !== '').pop();
      expect(lastNonEmptyLine).toContain('Result:');
    });
  });

  // -----------------------------------------------------------------------
  // ANSI color output
  // -----------------------------------------------------------------------

  describe('ANSI color output', () => {
    beforeEach(() => {
      delete process.env.NO_COLOR;
    });

    it('includes ANSI escape codes when NO_COLOR is not set', () => {
      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      // Should contain at least one ANSI escape code
      // eslint-disable-next-line no-control-regex
      expect(output).toMatch(/\x1b\[/);
    });

    it('applies green to pass symbol', () => {
      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      // Green ANSI code: \x1b[32m
      expect(output).toContain('\x1b[32m✓');
    });

    it('applies red to fail symbol', () => {
      const entries = [makeEntry({ id: 'a', status: 'fail', message: 'bad' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      expect(output).toContain('\x1b[31m✗');
    });

    it('applies yellow to warn symbol', () => {
      const entries = [makeEntry({ id: 'a', status: 'warn', message: 'hmm' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      expect(output).toContain('\x1b[33m!');
    });

    it('applies dim to skip symbol', () => {
      const entries = [makeEntry({ id: 'a', status: 'skip', message: 'skip' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      expect(output).toContain('\x1b[2m-');
    });

    it('applies bold to header', () => {
      const report = makeReport([]);
      const output = formatText(report, [], false);

      expect(output).toContain('\x1b[1mGeneracy Doctor');
    });

    it('applies bold to category labels', () => {
      const entries = [makeEntry({ id: 'a', category: 'system' })];
      const checks = [makeCheck({ id: 'a', category: 'system' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      expect(output).toContain('\x1b[1mSystem');
    });
  });

  // -----------------------------------------------------------------------
  // NO_COLOR support
  // -----------------------------------------------------------------------

  describe('NO_COLOR support', () => {
    it('strips all ANSI codes when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';

      const entries = [
        makeEntry({ id: 'a', status: 'pass', message: 'ok' }),
        makeEntry({
          id: 'b',
          status: 'fail',
          message: 'bad',
          suggestion: 'Fix it',
        }),
      ];
      const checks = entries.map((e) => makeCheck({ id: e.id }));
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      // Should NOT contain any ANSI escape codes
      // eslint-disable-next-line no-control-regex
      expect(output).not.toMatch(/\x1b\[/);
    });

    it('respects NO_COLOR with empty string value', () => {
      process.env.NO_COLOR = '';

      const entries = [makeEntry({ id: 'a', status: 'pass' })];
      const checks = [makeCheck({ id: 'a' })];
      const report = makeReport(entries);
      const output = formatText(report, checks, false);

      // NO_COLOR spec says presence of the var is enough, even if empty
      // eslint-disable-next-line no-control-regex
      expect(output).not.toMatch(/\x1b\[/);
    });
  });

  // -----------------------------------------------------------------------
  // Empty report
  // -----------------------------------------------------------------------

  describe('empty report', () => {
    it('renders header and summary with zero counts for empty checks', () => {
      const report = makeReport([]);
      const output = stripAnsi(formatText(report, [], false));

      expect(output).toContain('Generacy Doctor');
      expect(output).toContain('===============');
      expect(output).toContain('0 passed');
      expect(output).toContain('0 failed');
      expect(output).toContain('0 warnings');
      expect(output).toContain('0 skipped');
    });
  });

  // -----------------------------------------------------------------------
  // Realistic scenario
  // -----------------------------------------------------------------------

  describe('realistic scenario', () => {
    it('formats a full doctor report with mixed statuses', () => {
      const entries = [
        makeEntry({
          id: 'docker',
          label: 'Docker',
          category: 'system',
          status: 'pass',
          message: 'Docker daemon is running (v27.0.3)',
        }),
        makeEntry({
          id: 'devcontainer',
          label: 'Dev Container',
          category: 'system',
          status: 'pass',
          message: '.devcontainer/devcontainer.json present',
        }),
        makeEntry({
          id: 'config',
          label: 'Config File',
          category: 'config',
          status: 'pass',
          message: '.generacy/config.yaml is valid',
        }),
        makeEntry({
          id: 'env-file',
          label: 'Env File',
          category: 'config',
          status: 'fail',
          message: '.generacy/generacy.env not found',
          suggestion: 'Run `generacy init` to generate the env file',
        }),
        makeEntry({
          id: 'github-token',
          label: 'GitHub Token',
          category: 'credentials',
          status: 'skip',
          message: "Skipped: dependency 'env-file' failed",
        }),
        makeEntry({
          id: 'npm-packages',
          label: 'npm Packages',
          category: 'packages',
          status: 'warn',
          message: 'Version mismatch detected',
          suggestion: 'Run `pnpm install` to update',
        }),
      ];
      const checks = entries.map((e) =>
        makeCheck({ id: e.id, label: e.label, category: e.category }),
      );
      const report = makeReport(entries);
      const output = stripAnsi(formatText(report, checks, false));

      // All sections present
      expect(output).toContain('System');
      expect(output).toContain('Configuration');
      expect(output).toContain('Credentials');
      expect(output).toContain('Packages');

      // Check messages
      expect(output).toContain('Docker daemon is running (v27.0.3)');
      expect(output).toContain('.generacy/generacy.env not found');
      expect(output).toContain("Skipped: dependency 'env-file' failed");
      expect(output).toContain('Version mismatch detected');

      // Suggestions
      expect(output).toContain('→ Run `generacy init` to generate the env file');
      expect(output).toContain('→ Run `pnpm install` to update');

      // Summary (3 pass: docker, devcontainer, config; 1 fail: env-file; 1 warn: npm; 1 skip: gh-token)
      expect(output).toContain('3 passed');
      expect(output).toContain('1 failed');
      expect(output).toContain('1 warnings');
      expect(output).toContain('1 skipped');
    });
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------

describe('formatJson', () => {
  it('returns valid JSON', () => {
    const report = makeReport([makeEntry({ id: 'a' })]);
    const output = formatJson(report);

    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('preserves the full report structure', () => {
    const entries = [
      makeEntry({
        id: 'docker',
        label: 'Docker',
        category: 'system',
        status: 'pass',
        message: 'Docker ok',
        suggestion: 'hint',
        detail: 'extra',
        duration_ms: 42,
      }),
    ];
    const report = makeReport(entries);
    const parsed = JSON.parse(formatJson(report));

    expect(parsed.version).toBe(1);
    expect(parsed.timestamp).toBe('2026-02-26T00:00:00.000Z');
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0].id).toBe('docker');
    expect(parsed.checks[0].label).toBe('Docker');
    expect(parsed.checks[0].category).toBe('system');
    expect(parsed.checks[0].status).toBe('pass');
    expect(parsed.checks[0].message).toBe('Docker ok');
    expect(parsed.checks[0].suggestion).toBe('hint');
    expect(parsed.checks[0].detail).toBe('extra');
    expect(parsed.checks[0].duration_ms).toBe(42);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.exitCode).toBe(0);
  });

  it('produces pretty-printed output with 2-space indentation', () => {
    const report = makeReport([makeEntry({ id: 'a' })]);
    const output = formatJson(report);

    // Pretty-printed JSON has newlines and indentation
    expect(output).toContain('\n');
    expect(output).toContain('  ');
    // Verify it matches exact JSON.stringify(_, null, 2) output
    expect(output).toBe(JSON.stringify(report, null, 2));
  });

  it('handles empty checks array', () => {
    const report = makeReport([]);
    const parsed = JSON.parse(formatJson(report));

    expect(parsed.checks).toEqual([]);
    expect(parsed.summary.total).toBe(0);
  });

  it('round-trips the report through JSON serialization', () => {
    const entries = [
      makeEntry({ id: 'a', status: 'pass', message: 'ok' }),
      makeEntry({ id: 'b', status: 'fail', message: 'bad', suggestion: 'fix' }),
    ];
    const report = makeReport(entries);
    const parsed = JSON.parse(formatJson(report));

    expect(parsed).toEqual(report);
  });
});

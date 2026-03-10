import type {
  CheckCategory,
  CheckDefinition,
  DoctorReport,
  DoctorReportCheckEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// ANSI escape helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
} as const;

/** Whether color output is disabled via `NO_COLOR` env var. */
function isColorDisabled(): boolean {
  return 'NO_COLOR' in process.env;
}

function color(code: string, text: string): string {
  if (isColorDisabled()) return text;
  return `${code}${text}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------
// Status symbols and styling
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<CheckCategory, string> = {
  system: 'System',
  config: 'Configuration',
  credentials: 'Credentials',
  packages: 'Packages',
  services: 'Services',
};

/** Ordered list of categories for consistent output. */
const CATEGORY_ORDER: CheckCategory[] = [
  'system',
  'config',
  'credentials',
  'packages',
  'services',
];

function statusSymbol(status: DoctorReportCheckEntry['status']): string {
  switch (status) {
    case 'pass':
      return color(ANSI.green, '✓');
    case 'fail':
      return color(ANSI.red, '✗');
    case 'warn':
      return color(ANSI.yellow, '!');
    case 'skip':
      return color(ANSI.dim, '-');
  }
}

function statusColor(status: DoctorReportCheckEntry['status'], text: string): string {
  switch (status) {
    case 'pass':
      return color(ANSI.green, text);
    case 'fail':
      return color(ANSI.red, text);
    case 'warn':
      return color(ANSI.yellow, text);
    case 'skip':
      return color(ANSI.dim, text);
  }
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/**
 * Format a doctor report as color-coded text output grouped by category.
 *
 * Example output:
 * ```
 * Generacy Doctor
 * ===============
 *
 * System
 *   ✓ Docker           Docker daemon is running (v27.0.3)
 *   ✓ Dev Container    .devcontainer/devcontainer.json present
 *
 * Configuration
 *   ✓ Config File      .generacy/config.yaml is valid
 *   ✗ Env File         .generacy/generacy.env not found
 *     → Run `generacy init` to generate the env file
 *
 * Result: 2 passed, 1 failed, 0 warnings, 0 skipped
 * ```
 */
export function formatText(
  report: DoctorReport,
  checks: CheckDefinition[],
  verbose: boolean,
): string {
  const lines: string[] = [];

  // Header
  lines.push(color(ANSI.bold, 'Generacy Doctor'));
  lines.push('===============');
  lines.push('');

  // Build a lookup from check ID → definition for label padding
  const checkDefs = new Map(checks.map((c) => [c.id, c]));

  // Group entries by category (preserving order within each category)
  const grouped = groupByCategory(report.checks);

  for (const category of CATEGORY_ORDER) {
    const entries = grouped.get(category);
    if (!entries || entries.length === 0) continue;

    lines.push(color(ANSI.bold, CATEGORY_LABELS[category]!));

    // Compute label padding for alignment within this category
    const maxLabelLen = Math.max(
      ...entries.map((e) => {
        const def = checkDefs.get(e.id);
        return (def?.label ?? e.label).length;
      }),
    );

    for (const entry of entries) {
      const def = checkDefs.get(entry.id);
      const label = def?.label ?? entry.label;
      const paddedLabel = label.padEnd(maxLabelLen);
      const symbol = statusSymbol(entry.status);

      lines.push(`  ${symbol} ${paddedLabel}   ${entry.message}`);

      // Suggestion line (fail/warn)
      if (entry.suggestion && (entry.status === 'fail' || entry.status === 'warn')) {
        lines.push(statusColor(entry.status, `    → ${entry.suggestion}`));
      }

      // Detail line (verbose only)
      if (verbose && entry.detail) {
        lines.push(color(ANSI.dim, `    ${entry.detail}`));
      }
    }

    lines.push('');
  }

  // Summary line
  const { passed, failed, warnings, skipped } = report.summary;
  const parts: string[] = [
    color(ANSI.green, `${passed} passed`),
    color(ANSI.red, `${failed} failed`),
    color(ANSI.yellow, `${warnings} warnings`),
    color(ANSI.dim, `${skipped} skipped`),
  ];
  lines.push(`Result: ${parts.join(', ')}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON formatter
// ---------------------------------------------------------------------------

/**
 * Format a doctor report as pretty-printed JSON.
 */
export function formatJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group check entries by their category, preserving insertion order within
 * each group.
 */
function groupByCategory(
  entries: DoctorReportCheckEntry[],
): Map<CheckCategory, DoctorReportCheckEntry[]> {
  const map = new Map<CheckCategory, DoctorReportCheckEntry[]>();
  for (const entry of entries) {
    let group = map.get(entry.category);
    if (!group) {
      group = [];
      map.set(entry.category, group);
    }
    group.push(entry);
  }
  return map;
}

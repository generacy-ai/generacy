import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

/**
 * FR-009 / SC-004 source-grep guard.
 *
 * The P1 route stack selects a provider config dir via CLAUDE_CONFIG_DIR
 * (gateway launches) and never via the Claude CLI's `--settings` flag. A
 * `--settings` argument would bypass the per-launch config-dir routing and
 * break the "flag-free by construction" byte-identity guarantee for
 * subscription launches. This test walks both launch-path source trees and
 * asserts no non-test source file references `--settings`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCAN_DIRS = [
  resolve(__dirname, '..'),
  resolve(__dirname, '../../../..', 'generacy-plugin-claude-code/src/launch'),
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('no --settings flag in launch-path sources (FR-009 / SC-004)', () => {
  const sourceFiles = SCAN_DIRS.flatMap(collectSourceFiles);

  it('scans at least one file from each launch-path source tree', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const dir of SCAN_DIRS) {
      expect(sourceFiles.some((f) => f.startsWith(dir))).toBe(true);
    }
  });

  it.each(sourceFiles.map((f) => [f] as const))(
    '%s contains no --settings flag',
    (file) => {
      const content = readFileSync(file, 'utf8');
      expect(content.includes('--settings')).toBe(false);
    },
  );
});

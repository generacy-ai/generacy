/**
 * Completion summary and next steps for `generacy init`.
 *
 * After files are written (or previewed in dry-run mode), this module
 * prints a styled summary table showing each file's action and size,
 * followed by actionable next steps for the developer.
 */
import * as p from '@clack/prompts';
import type { FileResult } from './types.js';

// ---------------------------------------------------------------------------
// Action label mapping
// ---------------------------------------------------------------------------

/** Display labels for each file action (normal and dry-run variants). */
const ACTION_LABELS: Record<FileResult['action'], { normal: string; dryRun: string }> = {
  created: { normal: 'Created', dryRun: 'Would create' },
  overwritten: { normal: 'Overwritten', dryRun: 'Would overwrite' },
  merged: { normal: 'Merged', dryRun: 'Would merge' },
  skipped: { normal: 'Skipped', dryRun: 'Would skip' },
};

// ---------------------------------------------------------------------------
// Size formatting
// ---------------------------------------------------------------------------

/** Format a byte count for display, omitting for zero-size (skipped) files. */
function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return ` (${bytes} bytes)`;
  return ` (${(bytes / 1024).toFixed(1)} KB)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print a summary table of all file operations.
 *
 * Each file is displayed with its action label, relative path, and size.
 * In dry-run mode, actions are prefixed with "Would" (e.g. "Would create").
 * A totals line follows showing counts of each action type.
 *
 * @param results - Array of file results from `writeFiles()`.
 * @param dryRun  - Whether this was a dry-run (preview) invocation.
 */
export function printSummary(results: FileResult[], dryRun: boolean): void {
  if (results.length === 0) {
    p.log.warn('No files were generated.');
    return;
  }

  // Find the longest action label for alignment
  const variant = dryRun ? 'dryRun' : 'normal';
  const maxLabelLen = Math.max(
    ...results.map((r) => ACTION_LABELS[r.action][variant].length),
  );

  // Print each file result
  for (const result of results) {
    const label = ACTION_LABELS[result.action][variant].padEnd(maxLabelLen);
    const size = formatSize(result.size);
    p.log.step(`${label}  ${result.path}${size}`);
  }

  // Build totals
  const counts: Partial<Record<FileResult['action'], number>> = {};
  for (const result of results) {
    counts[result.action] = (counts[result.action] ?? 0) + 1;
  }

  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.overwritten) parts.push(`${counts.overwritten} overwritten`);
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);

  const totalLine = parts.join(', ');

  if (dryRun) {
    p.log.info(`Dry run: ${totalLine} (no files were written)`);
  } else {
    p.log.success(`Done: ${totalLine}`);
  }
}

/**
 * Print actionable next steps after a successful initialization.
 *
 * Displayed as a styled note box via `@clack/prompts`.
 */
export function printNextSteps(): void {
  p.note(
    [
      '1. Review the generated files',
      '2. Copy .generacy/generacy.env.template to .generacy/generacy.env and fill in credentials',
      '3. Run `generacy doctor` to verify system requirements',
      '4. Commit the generated files to your repository',
    ].join('\n'),
    'Next steps',
  );
}
